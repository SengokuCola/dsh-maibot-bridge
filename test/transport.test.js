import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createConnection, createServer } from 'node:net'
import test from 'node:test'

import { createTransport } from '../transport.js'

test('registers a workspace and titles only new ACP sessions while preserving image payloads', async () => {
  const calls = []
  const ctx = {
    workspaceController: { async create(value) { calls.push(['workspace', value]) } },
    sessionController: { async rename(value) { calls.push(['rename', value]) } },
  }
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const connected = once(server, 'connection')
  const client = createConnection(server.address().port, '127.0.0.1')
  const [socket] = await connected
  const stream = createTransport(socket, ctx, '麦麦')
  const reader = stream.readable.getReader()
  const writer = stream.writable.getWriter()
  try {
    const input = { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: 'C:/work' } }
    const encoded = JSON.stringify(input) + '\n'
    client.write(encoded.slice(0, 20))
    client.write(encoded.slice(20))
    assert.deepEqual((await reader.read()).value, input)
    assert.deepEqual(calls, [['workspace', { path: 'C:/work' }]])
    const response = { jsonrpc: '2.0', id: 1, result: { sessionId: 'owned-session' } }
    const received = once(client, 'data')
    await writer.write(response)
    assert.deepEqual(JSON.parse((await received)[0].toString()), response)
    assert.deepEqual(calls[1], ['rename', { sessionId: 'owned-session', title: '麦麦' }])
    const image = { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { prompt: [{ type: 'image', data: 'ABC123', mimeType: 'image/png' }] } }
    client.write(JSON.stringify(image) + '\n')
    assert.deepEqual((await reader.read()).value, image)
    const resume = { jsonrpc: '2.0', id: 3, method: 'session/resume', params: { cwd: 'C:/work', sessionId: 'owned-session' } }
    client.write(JSON.stringify(resume) + '\n')
    assert.deepEqual((await reader.read()).value, resume)
    await writer.write({ id: 3, result: { sessionId: 'owned-session' } })
    assert.equal(calls.filter(([name]) => name === 'rename').length, 1)
  } finally {
    client.destroy()
    socket.destroy()
    reader.releaseLock()
    writer.releaseLock()
    server.close()
  }
})
