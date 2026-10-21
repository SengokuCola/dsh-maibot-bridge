import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { createTransport } from './transport.js'
import { applyDesktopACP } from './desktop-acp.js'

export const name = 'maibot-desktop-bridge'
export const inject = ['agents', 'sessions', 'llm', 'attachments', 'workspaceController', 'sessionController']

/** Authenticate before handing the socket to dsh's ACP implementation. */
function authenticate(socket, token) {
  return new Promise((resolveAuth, reject) => {
    let pending = Buffer.alloc(0)
    const fail = error => { socket.off('data', receive); reject(error) }
    socket.once('error', fail)
    socket.once('end', () => fail(new Error('Desktop bridge disconnected before authentication')))
    socket.setTimeout(5000, () => socket.destroy(new Error('Desktop bridge authentication timed out')))
    function receive(chunk) {
      pending = Buffer.concat([pending, chunk])
      if (pending.length > 8192) return socket.destroy(new Error('Invalid Desktop bridge handshake'))
      const end = pending.indexOf(10)
      if (end < 0) return
      socket.pause()
      socket.off('data', receive)
      socket.off('error', fail)
      socket.setTimeout(0)
      try {
        const supplied = Buffer.from(JSON.parse(pending.subarray(0, end).toString()).token)
        const expected = Buffer.from(token)
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Desktop bridge authentication failed')
        if (pending.length > end + 1) socket.unshift(pending.subarray(end + 1))
        resolveAuth()
      } catch (error) { reject(error) }
    }
    socket.on('data', receive)
  })
}

export function apply(ctx, config = {}) {
  ctx.effect(async () => {
    const manifest = resolve(config.manifest ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'maibot-desktop.json'))
    const token = randomBytes(32).toString('base64url')
    const sockets = new Set()
    const forks = new Set()
    const owners = new Map()
    const server = createServer(socket => {
      sockets.add(socket)
      socket.on('error', error => ctx.logger.warn(`maibot bridge: ${error.message}`))
      socket.once('close', () => sockets.delete(socket))
      authenticate(socket, token).then(async () => {
        const stream = createTransport(socket, ctx, config.title ?? '麦麦')
        const fork = ctx.plugin({
          name: 'maibot-acp-connection',
          apply(child) { applyDesktopACP(child, stream, owners) },
        })
        forks.add(fork)
        socket.once('close', () => {
          fork.dispose().then(() => forks.delete(fork)).catch(error => ctx.logger.error(error))
        })
        await fork
        socket.write(JSON.stringify({ authenticated: true }) + '\n')
        socket.resume()
      }).catch(error => socket.destroy(error))
    })
    await new Promise((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    try {
      await mkdir(dirname(manifest), { recursive: true })
      await writeFile(manifest, JSON.stringify({ version: 1, host: '127.0.0.1', port: server.address().port, token }), { mode: 0o600 })
    } catch (error) {
      server.close()
      for (const socket of sockets) socket.destroy()
      await Promise.all([...forks].map(fork => fork.dispose()))
      throw error
    }
    ctx.logger.info('麦麦 Desktop ACP 桥接已就绪')
    return async () => {
      const closed = new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
      for (const socket of sockets) socket.destroy()
      await Promise.all([...forks].map(fork => fork.dispose()))
      await closed
      const current = JSON.parse(await readFile(manifest, 'utf8'))
      if (current.token === token) await unlink(manifest)
    }
  }, 'maibot.desktop-bridge')
}
