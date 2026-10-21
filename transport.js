import { Readable } from 'node:stream'

/** ACP framing stays unchanged; only workspace registration and session titles are added. */
export function createTransport(socket, ctx, title) {
  const fresh = new Set()
  let buffer = ''
  const readable = Readable.toWeb(socket).pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream({
    async transform(chunk, controller) {
      buffer += chunk
      if (buffer.length > 64 * 1024 * 1024) throw new Error('ACP message exceeds 64 MiB')
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (message.method === 'session/new' || message.method === 'session/resume') {
          await ctx.workspaceController.create({ path: message.params.cwd })
          if (message.method === 'session/new') fresh.add(message.id)
        }
        controller.enqueue(message)
      }
    },
    flush() {
      if (buffer.trim()) throw new Error('Truncated ACP message')
    },
  }))
  const writable = new WritableStream({
    async write(message) {
      if (fresh.delete(message.id) && message.result?.sessionId) {
        await ctx.sessionController.rename({ sessionId: message.result.sessionId, title })
      }
      await new Promise((resolve, reject) => {
        socket.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve())
      })
    },
    close() { socket.end() },
    abort(error) { socket.destroy(error instanceof Error ? error : new Error(String(error))) },
  })
  return { readable, writable }
}
