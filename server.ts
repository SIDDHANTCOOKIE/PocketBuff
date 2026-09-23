import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { ApprovalGate } from './approval.js'
import { messagesForEvent } from './events.js'
import type { ChatRuntime } from './runtime.js'
import { CodebuffRuntime, MockRuntime } from './runtime.js'
import { SessionManager } from './session.js'
import type { ClientMessage, ServerMessage, ToolCard } from './protocol.js'

export interface ServerOptions { port?: number; host?: string; projectDir?: string; token?: string; runtime?: ChatRuntime; staticDir?: string; stateDir?: string }
type RunContext = { abort: AbortController; approvals: ApprovalGate; tools: Map<string, ToolCard>; owner: WebSocket }

function send(socket: WebSocket, value: ServerMessage) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)) }
function safeEqual(a: string, b: string) { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && crypto.timingSafeEqual(aa, bb) }

export function createCompanionServer(options: ServerOptions = {}) {
  const defaultProjectDir = path.resolve(options.projectDir || process.env.FREEBUFF_PROJECT_DIR || process.cwd())
  const token = options.token ?? process.env.FREEBUFF_REMOTE_TOKEN ?? ''
  const staticDir = options.staticDir ?? path.resolve('dist/client')
  const stateDir = options.stateDir ?? path.join(os.homedir(), '.config', 'freebuff-remote')
  const mock = options.runtime?.name === 'mock' || process.env.FREEBUFF_REMOTE_MOCK === '1'
  const sessions = new SessionManager(path.join(stateDir, 'sessions.json'), (projectDir, id) => options.runtime ?? (mock ? new MockRuntime() : new CodebuffRuntime(projectDir, undefined, path.join(stateDir, 'sessions', `${id}.json`))), defaultProjectDir)
  const activeRuns = new Map<string, RunContext>()

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, runtime: mock ? 'mock' : 'codebuff', sessions: sessions.list().length })); return }
    const requestPath = req.url === '/' ? 'index.html' : (req.url || '/').replace(/^\//, '')
    const resolved = path.resolve(staticDir, requestPath)
    if ((resolved !== path.resolve(staticDir) && !resolved.startsWith(path.resolve(staticDir) + path.sep)) || !fs.existsSync(resolved)) { res.writeHead(404); res.end('Not found'); return }
    const mime = resolved.endsWith('.html') ? 'text/html; charset=utf-8' : resolved.endsWith('.js') ? 'text/javascript; charset=utf-8' : resolved.endsWith('.css') ? 'text/css; charset=utf-8' : resolved.endsWith('.svg') ? 'image/svg+xml' : resolved.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream'
    res.writeHead(200, { 'content-type': mime }); fs.createReadStream(resolved).pipe(res)
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost'); const supplied = url.searchParams.get('token') || ''
    if (url.pathname !== '/ws' || (token && !safeEqual(supplied, token))) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (socket) => {
    let activeSessionId = sessions.list()[0].id
    const sessionUpdate = () => send(socket, { type: 'sessions', sessions: sessions.list(), activeSessionId })
    send(socket, { type: 'ready', runtime: mock ? 'mock' : 'codebuff', sessions: sessions.list(), activeSessionId })
    socket.on('message', async (raw) => {
      let message: ClientMessage
      try { message = JSON.parse(raw.toString()) as ClientMessage } catch { send(socket, { type: 'error', message: 'Invalid JSON' }); return }
      if (message.type === 'ping') { send(socket, { type: 'pong' }); return }
      if (message.type === 'session-create') { const session = sessions.create(message.name, message.projectDir); activeSessionId = session.id; sessionUpdate(); return }
      if (message.type === 'session-select') { if (!sessions.get(message.sessionId)) send(socket, { type: 'error', message: 'Unknown session' }); else { activeSessionId = message.sessionId; sessionUpdate() }; return }
      if (message.type === 'session-delete') { if (activeRuns.has(message.sessionId)) { send(socket, { type: 'error', message: 'Cannot delete a running session' }); return }; sessions.delete(message.sessionId); activeSessionId = sessions.list()[0]?.id ?? sessions.create('Project', defaultProjectDir).id; sessionUpdate(); return }
      const session = sessions.get(message.sessionId)
      if (!session) { send(socket, { type: 'error', message: 'Unknown session' }); return }
      if (message.type === 'approval') { const run = activeRuns.get(session.id); if (!run?.approvals.resolve(message.requestId, message.decision)) send(socket, { type: 'error', message: 'Unknown approval request' }); else send(socket, { type: 'approval-resolved', sessionId: session.id, requestId: message.requestId, decision: message.decision }); return }
      if (message.type === 'cancel') { const run = activeRuns.get(session.id); run?.abort.abort(); run?.approvals.clear(); send(socket, { type: 'run-cancelled', sessionId: session.id }); return }
      if (message.type !== 'chat' || !message.text.trim()) { send(socket, { type: 'error', message: 'Expected a non-empty chat message' }); return }
      if (activeRuns.has(session.id)) { send(socket, { type: 'error', message: 'This session already has a run in progress' }); return }
      const run: RunContext = { abort: new AbortController(), approvals: new ApprovalGate(), tools: new Map(), owner: socket }; activeRuns.set(session.id, run)
      send(socket, { type: 'run-start', sessionId: session.id })
      try {
        const output = await session.runtime.run(message.text.trim(), {
          event: (event) => { for (const item of messagesForEvent(event, run.tools)) send(socket, { ...item, sessionId: session.id } as ServerMessage) },
          chunk: (chunk) => send(socket, { type: 'chunk', sessionId: session.id, chunk }), signal: run.abort.signal,
          approve: async (toolName, input, reason) => { const { decision } = run.approvals.request(crypto.randomUUID(), toolName, input, reason, (request) => send(socket, { type: 'approval-request', sessionId: session.id, ...request })); return await decision === 'approve' },
        })
        sessions.touch(session.id); send(socket, { type: 'run-finish', sessionId: session.id, output }); sessionUpdate()
      } catch (error) { send(socket, { type: 'error', message: error instanceof Error ? error.message : String(error) }) }
      finally { run.approvals.clear(); activeRuns.delete(session.id) }
    })
    socket.on('close', () => { for (const run of activeRuns.values()) if (run.owner === socket) { run.abort.abort(); run.approvals.clear() } })
  })

  return { server, listen(port = options.port ?? Number(process.env.PORT || 8787), host = options.host ?? process.env.HOST ?? '127.0.0.1') { return new Promise<{ port: number; host: string }>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { const address = server.address(); resolve({ port: typeof address === 'object' && address ? address.port : port, host }) }) }) }, close() { for (const run of activeRuns.values()) run.abort.abort(); return new Promise<void>((resolve, reject) => { wss.close(); server.close((e) => e ? reject(e) : resolve()) }) } }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) { const app = createCompanionServer(); app.listen().then(({ host, port }) => console.log(`Freebuff Remote listening on http://${host}:${port}`)).catch((e) => { console.error(e); process.exit(1) }) }
