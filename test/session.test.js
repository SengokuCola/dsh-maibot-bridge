import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import { borrowDesktopSession, cancelDesktopPrompt } from '../session.js'

function desktop() {
  const calls = []
  const agent = {
    session: { header: { cwd: resolve('workspace') } },
    ctx: { plugin() { calls.push('mount'); return { async dispose() { calls.push('detach tools') } } } },
  }
  const ctx = { sessionController: { agents: { async resolveAgent() { calls.push('resolve existing'); return { agent } } } } }
  return { ctx, agent, calls }
}

test('reconnects to an already active Desktop Agent and leaves its lifetime with Desktop', async () => {
  const { ctx, agent, calls } = desktop()
  const owners = new Map()
  const params = { sessionId: 'active-desktop-session', cwd: resolve('workspace') }
  const first = await borrowDesktopSession(ctx, params, owners, () => {})
  assert.equal(first.agent, agent)
  await assert.rejects(borrowDesktopSession(ctx, params, owners, () => {}), /already has/)
  await Promise.all([first.release(), first.release()])
  assert.deepEqual(calls, ['resolve existing', 'mount', 'detach tools'])
  assert.equal(owners.size, 0)
  const again = await borrowDesktopSession(ctx, params, owners, () => {})
  assert.equal(again.agent, agent)
  await again.release()
})

test('a workspace mismatch releases the reservation without touching Desktop', async () => {
  const { ctx, calls } = desktop()
  const owners = new Map()
  await assert.rejects(borrowDesktopSession(ctx, { sessionId: 'same', cwd: resolve('wrong') }, owners, () => {}), /workspace/)
  assert.equal(owners.size, 0)
  assert.deepEqual(calls, ['resolve existing'])
})

test('failed tool mounting is disposed and releases the session reservation', async () => {
  const { ctx, agent, calls } = desktop()
  const owners = new Map()
  agent.ctx.plugin = () => ({ then(_resolve, reject) { reject(new Error('mount failed')) }, async dispose() { calls.push('detach failed tools') } })
  await assert.rejects(borrowDesktopSession(ctx, { sessionId: 'same', cwd: resolve('workspace') }, owners, () => {}), /mount failed/)
  assert.equal(owners.size, 0)
  assert.deepEqual(calls, ['resolve existing', 'detach failed tools'])
})

test('cancel removes only our queued prompt while Desktop is running another turn', () => {
  const removed = []
  let resolved
  const record = { agent: { inbox: { remove(id) { removed.push(id) } }, cancel() { assert.fail('must not cancel Desktop turn') } },
    currentTurn: 2, pending: { messageId: 'our-message', resolve(value) { resolved = value } } }
  cancelDesktopPrompt(record)
  assert.deepEqual(removed, ['our-message'])
  assert.deepEqual(resolved, { stopReason: 'cancelled' })
  record.pending.turn = 1
  cancelDesktopPrompt(record)
})

test('cancel forwards cancellation when our own turn is current', () => {
  const calls = []
  const record = { agent: { cancel(value) { calls.push(value) } }, currentTurn: 7, pending: { turn: 7 } }
  cancelDesktopPrompt(record)
  assert.deepEqual(calls, [{ kind: 'user' }])
})
