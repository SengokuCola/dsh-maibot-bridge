import { randomUUID } from 'node:crypto'
import { agent, methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

import { borrowDesktopSession, cancelDesktopPrompt } from './session.js'

/** Desktop owns the Agent lifetime. An ACP connection only borrows its session and mounts tools. */
export function applyDesktopACP(ctx, stream, owners) {
  const sessions = new Map()
  let closing
  const invalid = message => RequestError.invalidParams(undefined, message)
  const requireSession = id => {
    const record = sessions.get(id)
    if (!record) throw invalid(`Session is not attached: ${id}`)
    return record
  }
  const send = (record, update) => {
    record.tail = record.tail.then(() => connection.client.notify(methods.client.session.update, {
      sessionId: record.agent.id, update,
    }))
    record.tail.catch(error => record.pending?.reject(error))
  }
  async function content(block) {
    if (block.type === 'text') return { type: 'text', text: block.text }
    if (block.type === 'image') {
      const image = await ctx.attachments.readImage(block.attachment)
      return { type: 'image', data: Buffer.from(image.data).toString('base64'), mimeType: image.ref.mediaType }
    }
  }
  async function eventUpdates(record, event) {
    if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        const thought = block.type === 'reasoning'
        const converted = thought ? { type: 'text', text: block.text } : await content(block)
        if (converted) send(record, { sessionUpdate: thought ? 'agent_thought_chunk' : 'agent_message_chunk',
          messageId: event.data.message.id, content: converted })
      }
    } else if (event.type === 'tool/call') {
      send(record, { sessionUpdate: 'tool_call', toolCallId: event.data.callId, title: event.data.name,
        kind: 'other', status: 'in_progress', rawInput: event.data.arguments })
    } else if (event.type === 'tool/result') {
      const message = event.data.message
      const output = []
      for (const block of message.content) {
        const converted = await content(block)
        if (converted) output.push({ type: 'content', content: converted })
      }
      send(record, { sessionUpdate: 'tool_call_update', toolCallId: message.toolCallId,
        status: message.isError ? 'failed' : 'completed', content: output })
    }
  }
  ctx.on('session/event', (session, event) => {
    const record = sessions.get(session.id)
    if (!record || record.agent.session !== session) return
    const pending = record.pending
    if (event.type === 'turn/start') record.currentTurn = event.data.turn
    record.events = record.events.then(() => eventUpdates(record, event))
    record.events.catch(error => pending?.reject(error))
    if (event.type === 'turn/end' && pending?.turn === event.data.turn) {
      record.events.then(async () => {
        await record.tail
        await ctx.sessions.flush(session)
        if (event.data.reason.kind === 'error' || event.data.reason.kind === 'blocked') {
          throw new Error(JSON.stringify(event.data.reason))
        }
        pending.resolve({ stopReason: pending.cancelled ? 'cancelled' :
          event.data.reason.kind === 'max-tokens' ? 'max_tokens' : 'end_turn' })
      }).catch(pending.reject)
    }
  })
  ctx.on('agent/inbox/claimed', ({ agent: current, message, turn }) => {
    const record = sessions.get(current.id)
    if (record?.pending?.messageId === message.id) record.pending.turn = turn
  })
  ctx.on('agent/error', ({ agent: current, error }) => {
    const record = sessions.get(current.id)
    if (record?.pending?.turn !== undefined && record.pending.turn === record.currentTurn) record.pending.reject(error)
  })
  ctx.on('approval/request', async (request, next) => {
    const record = sessions.get(request.agent.id)
    if (!record?.pending || record.pending.turn === undefined || record.pending.turn !== record.currentTurn || !request.callId) return next()
    await record.tail
    const result = await connection.client.request(methods.client.session.requestPermission, {
      sessionId: request.agent.id, toolCall: { toolCallId: request.callId },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }],
    })
    return result.outcome.outcome === 'selected' && result.outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
  })
  async function options(record) {
    const selection = ctx.sessionController.agents.selectionFor(record.agent).current
    const catalog = await ctx.sessionController.modelCatalog()
    return [{ id: 'model', name: 'Model', type: 'select', category: 'model',
      currentValue: JSON.stringify([selection.provider, selection.model]),
      options: catalog.groups.map(group => ({ group: group.id, name: group.name,
        options: group.models.map(model => ({ value: JSON.stringify([group.id, model.id]), name: model.name })) })),
    }]
  }
  async function attach(params) {
    if (closing) throw invalid('Desktop bridge is closing')
    const sessionId = params.sessionId
    let lease
    try {
      lease = await borrowDesktopSession(ctx, params, owners, async child => {
        for (const server of params.mcpServers ?? []) {
          if (server.type !== 'http') throw invalid('Desktop bridge accepts HTTP MCP servers only')
          await child.plugin(McpClient, { transport: 'streamable-http', serverName: server.name,
            url: server.url, headers: Object.fromEntries(server.headers.map(item => [item.name, item.value])),
            failOnStartupError: true })
        }
      })
      const record = { ...lease, pending: null, tail: Promise.resolve(), events: Promise.resolve() }
      sessions.set(sessionId, record)
      return { configOptions: await options(record) }
    } catch (error) {
      if (lease) await lease.release()
      sessions.delete(sessionId)
      throw error
    }
  }
  async function detach(id) {
    const record = requireSession(id)
    try {
      cancelDesktopPrompt(record)
      await record.pending?.promise
      await record.events
      await record.tail
      await ctx.sessions.flush(record.agent.session)
    } finally {
      await record.release()
      sessions.delete(id)
    }
    return {}
  }
  async function prompt(params, signal) {
    const record = requireSession(params.sessionId)
    if (record.pending) throw invalid('An ACP prompt is already pending')
    const pending = { ...Promise.withResolvers(), messageId: undefined, turn: undefined, cancelled: false }
    record.pending = pending
    try {
      const selection = ctx.sessionController.agents.selectionFor(record.agent).current
      const blocks = []
      for (const block of params.prompt) {
        if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
        else if (block.type === 'image') {
          const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model, signal)
          if (!info.inputModalities?.includes('image')) throw invalid('Current Desktop model does not support images')
          const data = Buffer.from(block.data, 'base64')
          if (data.toString('base64') !== block.data) throw invalid('Image data is not canonical base64')
          const [attachment] = await ctx.attachments.saveImages([{ data, mediaType: block.mimeType }])
          blocks.push({ type: 'image', attachment })
        } else throw invalid(`Unsupported prompt content: ${block.type}`)
      }
      signal.throwIfAborted()
      if (pending.cancelled) return { stopReason: 'cancelled' }
      const message = createUserMessage({ content: blocks, source: { kind: 'user', rpcId: randomUUID() } })
      pending.messageId = message.id
      record.agent.followup(message)
      return await pending.promise
    } finally { record.pending = null }
  }
  const handle = callback => async ({ params, signal }) => {
    try { return await callback(params, signal) }
    catch (error) { throw error instanceof RequestError ? error : RequestError.internalError(undefined, error.message) }
  }
  const connection = agent({ name: 'maibot-desktop' })
    .onRequest(methods.agent.initialize, handle(async () => ({ protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'dsh-maibot-bridge', version: '0.1.1' }, agentCapabilities: {
        mcpCapabilities: { http: true }, promptCapabilities: { image: true }, sessionCapabilities: { resume: {}, close: {} },
      }, authMethods: [] })))
    .onRequest(methods.agent.session.new, handle(async params => {
      const { sessionId } = await ctx.sessionController.create({ cwd: params.cwd })
      return { sessionId, ...await attach({ ...params, sessionId }) }
    }))
    .onRequest(methods.agent.session.resume, handle(attach))
    .onRequest(methods.agent.session.prompt, handle(prompt))
    .onRequest(methods.agent.session.close, handle(params => detach(params.sessionId)))
    .onRequest(methods.agent.session.setConfigOption, handle(async params => {
      const record = requireSession(params.sessionId)
      if (params.configId !== 'model') throw invalid('Unknown config option')
      const [provider, model] = JSON.parse(params.value)
      await ctx.sessionController.selectModel({ sessionId: params.sessionId, provider, model })
      return { configOptions: await options(record) }
    }))
    .onNotification(methods.agent.session.cancel, ({ params }) => cancelDesktopPrompt(requireSession(params.sessionId)))
    .connect(stream)
  const close = () => closing ??= (async () => {
    const results = await Promise.allSettled([...sessions.keys()].map(detach))
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Desktop ACP detach failed')
  })()
  connection.closed.then(close, close).catch(error => ctx.logger.error(error))
  ctx.effect(() => close, 'maibot.desktop-acp')
}
