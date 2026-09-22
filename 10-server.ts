import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { CodebuffRuntime, MockRuntime, type ChatRuntime } from './runtime.js'
import { ApprovalGate } from './approval.js'
import { messagesForEvent } from './events.js'
import type { ToolCard } from './protocol.js'
import type { ClientMessage, ServerMessage } from './protocol.js'

export interface ServerOptions {
  port?: number
  host?: string
  projectDir?: string
  token?: string
  runtime?: ChatRuntime
  staticDir?: string
}

function send(socket: WebSocket, value: ServerMessage) {
  socket.send(JSON.stringify(value))
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a)
  const bb = Buffer.from(b)
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb)
}

export function createCompanionServer(options: ServerOptions = {}) {
  const projectDir = path.resolve(options.projectDir || process.env.FREEBUFF_PROJECT_DIR || process.cwd())
  const token = options.token ?? process.env.FREEBUFF_REMOTE_TOKEN ?? ''
  const staticDir = options.staticDir ?? path.resolve('dist/client')
  const runtime = options.runtime ?? (process.env.FREEBUFF_REMOTE_MOCK === '1' ? new MockRuntime() : new CodebuffRuntime(projectDir))
  let running = false
  let abortController: AbortController | null = null
  const approvals = new ApprovalGate()
  const tools = new Map<string, ToolCard>()

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, runtime: runtime.name, projectDir }))
      return
    }
    const requestPath = req.url === '/' ? 'index.html' : (req.url || '/').replace(/^\//, '')
    const resolved = path.resolve(staticDir, requestPath)
    if (!resolved.startsWith(path.resolve(staticDir)) || !fs.existsSync(resolved)) {
      res.writeHead(404); res.end('Not found'); return
    }
    res.writeHead(200, { 'content-type': resolved.endsWith('.html') ? 'text/html; charset=utf-8' : resolved.endsWith('.js') ? 'text/javascript; charset=utf-8' : resolved.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream' })
    fs.createReadStream(resolved).pipe(res)
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const supplied = url.searchParams.get('token') || ''
    if (url.pathname !== '/ws' || (token && !safeEqual(supplied, token))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (socket) => {
    send(socket, { type: 'ready', projectDir, runtime: runtime.name })
    socket.on('message', async (raw) => {
      let message: ClientMessage
      try { message = JSON.parse(raw.toString()) as ClientMessage } catch { send(socket, { type: 'error', message: 'Invalid JSON' }); return }
      if (message.type === 'ping') { send(socket, { type: 'pong' }); return }
      if (message.type === 'approval') {
        if (!approvals.resolve(message.requestId, message.decision)) send(socket, { type: 'error', message: 'Unknown approval request' })
        else send(socket, { type: 'approval-resolved', requestId: message.requestId, decision: message.decision })
        return
      }
      if (message.type === 'cancel') { abortController?.abort(); approvals.clear(); send(socket, { type: 'run-cancelled' }); return }
      if (message.type !== 'chat' || typeof message.text !== 'string' || !message.text.trim()) {
        send(socket, { type: 'error', message: 'Expected a non-empty chat message' }); return
      }
      if (running) { send(socket, { type: 'error', message: 'A run is already in progress' }); return }
      running = true
      abortController = new AbortController()
      tools.clear()
      send(socket, { type: 'run-start' })
      try {
        const output = await runtime.run(message.text.trim(), {
          event: (event) => {
            for (const message of messagesForEvent(event, tools)) send(socket, message)
          },
          chunk: (chunk) => send(socket, { type: 'chunk', chunk }),
          signal: abortController.signal,
          approve: async (toolName, input, reason) => {
            const { decision } = approvals.request(crypto.randomUUID(), toolName, input, reason, (request) => send(socket, { type: 'approval-request', ...request }))
            return await decision === 'approve'
          },
        })
        send(socket, { type: 'run-finish', output })
      } catch (error) {
        send(socket, { type: 'error', message: error instanceof Error ? error.message : String(error) })
      } finally { running = false; abortController = null; approvals.clear() }
    })
  })

  return {
    server,
    listen(port = options.port ?? Number(process.env.PORT || 8787), host = options.host ?? process.env.HOST ?? '127.0.0.1') {
      return new Promise<{ port: number; host: string }>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          const address = server.address()
          resolve({ port: typeof address === 'object' && address ? address.port : port, host })
        })
      })
    },
    close() { return new Promise<void>((resolve, reject) => { wss.close(); server.close((e) => e ? reject(e) : resolve()) }) },
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const app = createCompanionServer()
  app.listen().then(({ host, port }) => console.log(`Freebuff Remote listening on http://${host}:${port}`)).catch((e) => { console.error(e); process.exit(1) })
}
