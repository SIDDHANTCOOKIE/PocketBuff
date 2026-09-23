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
import { CodebuffRuntime, MockRuntime, defaultSlotClient, releaseSharedSlot } from './runtime.js'
import { readFreebuffToken } from './auth.js'
import { SessionManager } from './session.js'
import type { ClientMessage, ServerMessage, ToolCard } from './protocol.js'

export interface ServerOptions { port?: number; host?: string; projectDir?: string; token?: string; runtime?: ChatRuntime; staticDir?: string; stateDir?: string }
type RunContext = { abort: AbortController; approvals: ApprovalGate; tools: Map<string, ToolCard>; pending: Set<string> }
const HISTORY_LIMIT = 2000

function send(socket: WebSocket, value: ServerMessage) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)) }
const str = (value: unknown) => typeof value === 'string'
function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  switch (m.type) {
    case 'ping': return true
    case 'chat': return str(m.sessionId) && str(m.text)
    case 'approval': return str(m.sessionId) && str(m.requestId) && (m.decision === 'approve' || m.decision === 'deny')
    case 'cancel': case 'session-select': case 'session-delete': return str(m.sessionId)
    case 'session-create': return str(m.name) && str(m.projectDir) && (m.projectDir as string).trim() !== ''
    default: return false
  }
}
function safeEqual(a: string, b: string) { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && crypto.timingSafeEqual(aa, bb) }

export function createCompanionServer(options: ServerOptions = {}) {
  const defaultProjectDir = path.resolve(options.projectDir || process.env.FREEBUFF_PROJECT_DIR || process.cwd())
  const token = options.token ?? process.env.FREEBUFF_REMOTE_TOKEN ?? ''
  const staticDir = options.staticDir ?? path.resolve('dist/client')
  const stateDir = options.stateDir ?? path.join(os.homedir(), '.config', 'freebuff-remote')
  const mock = options.runtime?.name === 'mock' || process.env.FREEBUFF_REMOTE_MOCK === '1'
  const sessions = new SessionManager(path.join(stateDir, 'sessions.json'), (projectDir, id) => { if (options.runtime) return options.runtime; if (mock) return new MockRuntime(); const token = readFreebuffToken(); return new CodebuffRuntime(projectDir, token, path.join(stateDir, 'sessions', `${id}.json`), defaultSlotClient(token, stateDir)) }, defaultProjectDir)
  // An explicitly configured project folder wins over whatever session was saved last, so a new FREEBUFF_PROJECT_DIR is not silently ignored.
  const explicitProject = options.projectDir || process.env.FREEBUFF_PROJECT_DIR ? sessions.ensure(defaultProjectDir).id : undefined
  const activeRuns = new Map<string, RunContext>()
  // Session-scoped messages are kept so a phone that reloads or reconnects sees the same transcript and pending approvals.
  const history = new Map<string, ServerMessage[]>()
  const clients = new Set<WebSocket>()
  const emit = (sessionId: string, value: ServerMessage) => {
    const log = history.get(sessionId) ?? []; const last = log.at(-1)
    // Subagent/reasoning chunks are not rendered, so keep them out of the replay log where they would evict the transcript.
    if (value.type === 'chunk' && typeof value.chunk !== 'string') { for (const client of clients) send(client, value); return }
    if (value.type === 'chunk' && last?.type === 'chunk' && typeof last.chunk === 'string') log[log.length - 1] = { ...last, chunk: last.chunk + (value.chunk as string) }; else log.push(value); if (log.length > HISTORY_LIMIT) log.splice(0, log.length - HISTORY_LIMIT); history.set(sessionId, log)
    for (const client of clients) send(client, value)
  }

  const server = http.createServer((req, res) => {
    let pathname = '/'
    try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname) } catch { res.writeHead(400); res.end('Bad request'); return }
    if (pathname === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, runtime: mock ? 'mock' : 'codebuff', sessions: sessions.list().length })); return }
    const requestPath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '')
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
    let activeSessionId = (explicitProject && sessions.get(explicitProject) ? explicitProject : undefined) ?? sessions.list()[0].id
    const sessionUpdate = () => send(socket, { type: 'sessions', sessions: sessions.list(), activeSessionId })
    clients.add(socket)
    send(socket, { type: 'ready', runtime: mock ? 'mock' : 'codebuff', sessions: sessions.list(), activeSessionId })
    for (const log of history.values()) for (const value of log) send(socket, value)
    socket.on('message', async (raw) => {
      let message: ClientMessage
      try { message = JSON.parse(raw.toString()) as ClientMessage } catch { send(socket, { type: 'error', message: 'Invalid JSON' }); return }
      // The handler is async, so a malformed payload that throws would become an unhandled rejection and stop the server.
      if (!isClientMessage(message)) { send(socket, { type: 'error', message: 'Malformed message' }); return }
      if (message.type === 'ping') { send(socket, { type: 'pong' }); return }
      if (message.type === 'session-create') { const session = sessions.create(message.name, message.projectDir); activeSessionId = session.id; sessionUpdate(); return }
      if (message.type === 'session-select') { if (!sessions.get(message.sessionId)) send(socket, { type: 'error', message: 'Unknown session' }); else { activeSessionId = message.sessionId; sessionUpdate() }; return }
      if (message.type === 'session-delete') { if (activeRuns.has(message.sessionId)) { send(socket, { type: 'error', message: 'Cannot delete a running session' }); return }; sessions.delete(message.sessionId); history.delete(message.sessionId); activeSessionId = sessions.list()[0]?.id ?? sessions.create('Project', defaultProjectDir).id; sessionUpdate(); return }
      const session = sessions.get(message.sessionId)
      if (!session) { send(socket, { type: 'error', message: 'Unknown session' }); return }
      if (message.type === 'approval') { const run = activeRuns.get(session.id); if (!run?.approvals.resolve(message.requestId, message.decision)) send(socket, { type: 'error', sessionId: session.id, message: 'Unknown approval request' }); else { run.pending.delete(message.requestId); emit(session.id, { type: 'approval-resolved', sessionId: session.id, requestId: message.requestId, decision: message.decision }) }; return }
      if (message.type === 'cancel') { const run = activeRuns.get(session.id); if (!run) return; run.abort.abort(); run.approvals.clear(); emit(session.id, { type: 'run-cancelled', sessionId: session.id }); return }
      if (message.type !== 'chat' || !message.text.trim()) { send(socket, { type: 'error', message: 'Expected a non-empty chat message' }); return }
      if (activeRuns.has(session.id)) { send(socket, { type: 'error', sessionId: session.id, message: 'This session already has a run in progress' }); return }
      const run: RunContext = { abort: new AbortController(), approvals: new ApprovalGate(), tools: new Map(), pending: new Set() }; activeRuns.set(session.id, run)
      emit(session.id, { type: 'user', sessionId: session.id, text: message.text.trim() })
      emit(session.id, { type: 'run-start', sessionId: session.id })
      try {
        const output = await session.runtime.run(message.text.trim(), {
          event: (event) => { for (const item of messagesForEvent(event, run.tools)) emit(session.id, { ...item, sessionId: session.id } as ServerMessage) },
          chunk: (chunk) => emit(session.id, { type: 'chunk', sessionId: session.id, chunk }), signal: run.abort.signal,
          approve: async (toolName, input, reason) => { const { decision } = run.approvals.request(crypto.randomUUID(), toolName, input, reason, (request) => { run.pending.add(request.requestId); emit(session.id, { type: 'approval-request', sessionId: session.id, ...request }) }); return await decision === 'approve' },
        })
        sessions.touch(session.id); emit(session.id, { type: 'run-finish', sessionId: session.id, output }); sessionUpdate()
      } catch (error) { if (!run.abort.signal.aborted) { emit(session.id, { type: 'error', sessionId: session.id, message: error instanceof Error ? error.message : String(error) }); emit(session.id, { type: 'run-finish', sessionId: session.id, output: null }) } }
      // Approvals left open by a cancel or failure are resolved as denied so replayed cards do not keep live buttons.
      finally { run.approvals.clear(); for (const requestId of run.pending) emit(session.id, { type: 'approval-resolved', sessionId: session.id, requestId, decision: 'deny' }); activeRuns.delete(session.id) }
    })
    // Runs keep going when a phone disconnects; reconnecting clients get the replayed transcript and can approve or cancel.
    socket.on('close', () => { clients.delete(socket) })
  })

  return { server, listen(port = options.port ?? Number(process.env.PORT || 8787), host = options.host ?? process.env.HOST ?? '127.0.0.1') { return new Promise<{ port: number; host: string }>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { const address = server.address(); resolve({ port: typeof address === 'object' && address ? address.port : port, host }) }) }) }, close() { for (const run of activeRuns.values()) run.abort.abort(); return new Promise<void>((resolve, reject) => { wss.close(); server.close((e) => e ? reject(e) : resolve()) }).finally(() => mock || options.runtime ? undefined : releaseSharedSlot()) } }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const app = createCompanionServer()
  app.listen().then(({ host, port }) => console.log(`Freebuff Remote listening on http://${host}:${port}`)).catch((e) => { console.error(e); process.exit(1) })
  // Give the Freebuff slot back on exit so the user's own CLI can be admitted right away.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { const timer = setTimeout(() => process.exit(0), 5000); app.close().catch(() => undefined).finally(() => { clearTimeout(timer); process.exit(0) }) })
}
