import { isAbsolute, resolve } from 'node:path'

/** Borrow Desktop's existing Agent or ask its controller to restore it; never acquire another writer. */
export async function borrowDesktopSession(ctx, params, owners, mountTools) {
  if (!isAbsolute(params.cwd)) throw new Error('cwd must be absolute')
  const id = params.sessionId
  if (owners.has(id)) throw new Error('This session already has a MaiBot ACP connection')
  const reservation = {}
  owners.set(id, reservation)
  let tools
  let releasing
  const release = () => releasing ??= (async () => {
    try { if (tools) await tools.dispose() }
    finally { if (owners.get(id) === reservation) owners.delete(id) }
  })()
  try {
    const found = await ctx.sessionController.agents.resolveAgent(id)
    if ('error' in found) throw found.error
    const agent = found.agent
    const canonical = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
    if (!agent.session.header.cwd || canonical(agent.session.header.cwd) !== canonical(params.cwd)) {
      throw new Error('Session workspace does not match cwd')
    }
    tools = agent.ctx.plugin({ name: 'maibot-session-tools', apply: mountTools })
    await tools
    return { agent, release }
  } catch (error) {
    await release()
    throw error
  }
}

/** Remove only our queued input, or cancel only our current turn; Desktop work keeps running. */
export function cancelDesktopPrompt(record) {
  const pending = record.pending
  if (!pending) return
  pending.cancelled = true
  if (pending.turn === undefined) {
    if (pending.messageId !== undefined) record.agent.inbox.remove(pending.messageId)
    pending.resolve({ stopReason: 'cancelled' })
  } else if (pending.turn === record.currentTurn) record.agent.cancel({ kind: 'user' })
}
