// Loopback TCP fault switch in front of a fake upstream (HTTP and WebSocket alike), used to make the service
// unavailable around a real packaged app without touching the app or its plugins:
//   up        forward every connection to the target
//   absent    nothing listens on the port (ECONNREFUSED), existing connections are destroyed
//   reset     accept, then destroy the socket immediately (crash / window closed abruptly)
//   blackhole accept and never answer (lab window closed behind a listener)
// Every transition and connection is journaled with epoch milliseconds.
import { connect, createServer } from 'node:net'

export async function createFaultProxy({ targetPort, host = '127.0.0.1', port = 0 }) {
  const journal = []
  const sockets = new Set()
  let mode = 'up'
  let server
  const note = (event, extra = {}) => journal.push({ at: Date.now(), event, mode, ...extra })

  const onConnection = (client) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.on('error', () => {})
    note('connection')
    if (mode === 'reset') { client.destroy(); return }
    if (mode === 'blackhole') return
    const upstream = connect(targetPort, host)
    sockets.add(upstream)
    upstream.on('close', () => { sockets.delete(upstream); client.destroy() })
    upstream.on('error', () => client.destroy())
    client.on('close', () => upstream.destroy())
    client.pipe(upstream)
    upstream.pipe(client)
  }

  const listen = listenPort => new Promise((resolve, reject) => {
    server = createServer(onConnection)
    server.once('error', reject)
    server.listen(listenPort, host, () => resolve(server.address().port))
  })
  const boundPort = await listen(port)

  return {
    port: boundPort,
    journal,
    get mode() { return mode },
    async setMode(next) {
      if (next === mode) return
      const previous = mode
      mode = next
      if (next === 'absent') {
        for (const socket of sockets) socket.destroy()
        await new Promise(resolve => server.close(() => resolve()))
      } else if (previous === 'absent') {
        for (let attempt = 0; ; attempt++) {
          try { await listen(boundPort); break } catch (error) { if (attempt > 50) throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
        }
      }
      if (next === 'reset') for (const socket of sockets) socket.destroy()
      note('mode', { from: previous })
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      if (mode !== 'absent') await new Promise(resolve => server.close(() => resolve()))
    },
  }
}
