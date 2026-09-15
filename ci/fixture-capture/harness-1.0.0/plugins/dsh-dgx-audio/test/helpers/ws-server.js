// Minimal RFC 6455 WebSocket server for offline tests (text frames, masking, ping, close).
// Test-only; it lets the plugin's real Node `WebSocket` client talk to a scripted backend.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function wsServer(onConnection) {
  const connections = []
  const server = createServer((req, res) => { res.writeHead(426); res.end() })
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'))
    const conn = new Connection(socket, req)
    connections.push(conn)
    onConnection(conn)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server,
    connections,
    port: server.address().port,
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise(r => { for (const c of connections) c.destroy(); server.close(() => r()) }),
  })))
}

class Connection {
  constructor(socket, req) {
    this.socket = socket
    this.url = new URL(req.url, 'http://x')
    this.buffer = Buffer.alloc(0)
    this.handlers = new Set()
    this.closeHandlers = new Set()
    this.received = []
    this.open = true
    socket.on('data', data => this.onData(data))
    socket.on('close', () => { this.open = false; for (const h of this.closeHandlers) h() })
    socket.on('error', () => {})
  }

  onMessage(handler) { this.handlers.add(handler) }
  onClose(handler) { this.closeHandlers.add(handler) }

  onData(data) {
    this.buffer = Buffer.concat([this.buffer, data])
    for (;;) {
      if (this.buffer.length < 2) return
      const b0 = this.buffer[0]
      const b1 = this.buffer[1]
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let length = b1 & 0x7f
      let offset = 2
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4 } else if (length === 127) { if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10 }
      const maskLen = masked ? 4 : 0
      if (this.buffer.length < offset + maskLen + length) return
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : undefined
      const payload = Buffer.from(this.buffer.subarray(offset + maskLen, offset + maskLen + length))
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      this.buffer = this.buffer.subarray(offset + maskLen + length)
      if (opcode === 0x8) { this.frame(0x8, payload.subarray(0, 2)); this.socket.end(); return }
      if (opcode === 0x9) { this.frame(0xA, payload); continue }
      if (opcode === 0x1) {
        const message = JSON.parse(payload.toString('utf8'))
        this.received.push(message)
        for (const h of this.handlers) h(message)
      }
    }
  }

  frame(opcode, payload) {
    if (!this.open || this.socket.destroyed) return
    const len = payload.length
    let header
    if (len < 126) header = Buffer.from([0x80 | opcode, len])
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2) } else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2) }
    this.socket.write(Buffer.concat([header, payload]))
  }

  send(message) { this.frame(0x1, Buffer.from(JSON.stringify(message), 'utf8')) }

  sendBinary(buf) { this.frame(0x2, Buffer.from(buf)) }

  /** Drop the TCP connection without a close handshake (network loss). */
  destroy() { this.open = false; this.socket.destroy() }
}
