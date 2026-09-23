import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createCompanionServer } from './server'
import { MockRuntime } from './runtime'

const apps: ReturnType<typeof createCompanionServer>[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })

describe('companion server', () => {
  it('runs a complete websocket chat loop', async () => {
    const app = createCompanionServer({ runtime: new MockRuntime(), token: 'secret' })
    apps.push(app)
    const { port } = await app.listen(0)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`)
    const messages: Array<Record<string, unknown>> = []
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject)
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString())
        messages.push(message)
        if (message.type === 'ready') ws.send(JSON.stringify({ type: 'chat', sessionId: message.activeSessionId, text: 'hello' }))
        if (message.type === 'run-finish') resolve()
      })
    })
    expect(messages.map((m) => m.type)).toEqual(expect.arrayContaining(['ready', 'run-start', 'event', 'chunk', 'run-finish']))
    expect(messages.find((m) => m.type === 'chunk')?.chunk).toContain('hello')
    ws.close()
  })

  it('pauses a sensitive tool until approved', async () => {
    const runtime = { name: 'mock' as const, async run(_prompt: string, handlers: import('./runtime').RuntimeHandlers) {
      const allowed = await handlers.approve?.('run_terminal_command', { command: 'pwd' }, 'needs approval')
      return { allowed }
    } }
    const app = createCompanionServer({ runtime, token: 'secret' })
    apps.push(app)
    const { port } = await app.listen(0)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`)
    const output = await new Promise<unknown>((resolve, reject) => {
      ws.on('error', reject)
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString())
        if (message.type === 'ready') ws.send(JSON.stringify({ type: 'chat', sessionId: message.activeSessionId, text: 'run' }))
        if (message.type === 'approval-request') ws.send(JSON.stringify({ type: 'approval', sessionId: message.sessionId, requestId: message.requestId, decision: 'approve' }))
        if (message.type === 'run-finish') resolve(message.output)
      })
    })
    expect(output).toEqual({ allowed: true })
    ws.close()
  })

  it('propagates cancel to the active runtime signal', async () => {
    const runtime = { name: 'mock' as const, async run(_prompt: string, handlers: import('./runtime').RuntimeHandlers) {
      await new Promise<void>((resolve) => handlers.signal?.addEventListener('abort', () => resolve(), { once: true }))
      return { cancelled: handlers.signal?.aborted }
    } }
    const app = createCompanionServer({ runtime, token: 'secret' })
    apps.push(app)
    const { port } = await app.listen(0)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`)
    const types: string[] = []
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject)
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()); types.push(message.type)
        if (message.type === 'ready') ws.send(JSON.stringify({ type: 'chat', sessionId: message.activeSessionId, text: 'wait' }))
        if (message.type === 'run-start') ws.send(JSON.stringify({ type: 'cancel', sessionId: message.sessionId }))
        if (message.type === 'run-finish') resolve()
      })
    })
    expect(types).toContain('run-cancelled')
    ws.close()
  })

  it('creates and selects a second persisted session', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-server-sessions-'))
    const app = createCompanionServer({ runtime: new MockRuntime(), token: 'secret', stateDir })
    apps.push(app)
    const { port } = await app.listen(0)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`)
    const sessions = await new Promise<Array<{ name: string }>>((resolve, reject) => {
      ws.on('error', reject)
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString())
        if (message.type === 'ready') ws.send(JSON.stringify({ type: 'session-create', name: 'Two', projectDir: '/tmp/two' }))
        if (message.type === 'sessions' && message.sessions.length === 2) resolve(message.sessions)
      })
    })
    expect(sessions.map(item => item.name)).toContain('Two')
    ws.close()
  })

  it('serves installable PWA assets with correct MIME types', async () => {
    const app = createCompanionServer({ runtime: new MockRuntime(), token: 'secret' })
    apps.push(app)
    const { port } = await app.listen(0)
    const manifest = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`)
    const worker = await fetch(`http://127.0.0.1:${port}/sw.js`)
    expect(manifest.headers.get('content-type')).toContain('manifest')
    expect((await manifest.json()).display).toBe('standalone')
    expect(worker.headers.get('content-type')).toContain('javascript')
  })

  it('serves built CSS with a browser-accepted MIME type', async () => {
    const app = createCompanionServer({ runtime: new MockRuntime(), token: 'secret' })
    apps.push(app)
    const { port } = await app.listen(0)
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    const cssPath = html.match(/href="([^"]+\.css)"/)?.[1]
    expect(cssPath).toBeTruthy()
    const response = await fetch(`http://127.0.0.1:${port}${cssPath}`)
    expect(response.headers.get('content-type')).toContain('text/css')
  })

  it('rejects malformed messages without stopping the server', async () => {
    const app = createCompanionServer({ runtime: new MockRuntime(), token: 'secret', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fbr-')) })
    apps.push(app)
    const { port } = await app.listen(0)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`)
    const errors: string[] = []
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject)
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString())
        if (message.type === 'ready') { for (const bad of ['null', '{"type":"chat"}', '{"type":"session-create","name":1}', '{"type":"approval","sessionId":"x","requestId":"y","decision":"maybe"}']) ws.send(bad); ws.send(JSON.stringify({ type: 'ping' })) }
        if (message.type === 'error') errors.push(message.message)
        if (message.type === 'pong') resolve()
      })
    })
    expect(errors).toEqual(['Malformed message', 'Malformed message', 'Malformed message', 'Malformed message'])
    ws.close()
  })

  it('rejects the wrong shared token', async () => {
    const app = createCompanionServer({ runtime: new MockRuntime(), token: 'secret' })
    apps.push(app)
    const { port } = await app.listen(0)
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=wrong`)
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode || 0))
    })
    expect(status).toBe(401)
  })
})

describe('static routing', () => {
  it('serves the app shell when the URL has a query string', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbr-static-'))
    fs.writeFileSync(path.join(dir, 'index.html'), '<main>shell</main>')
    const app = createCompanionServer({ runtime: new MockRuntime(), staticDir: dir, stateDir: path.join(dir, '.state') })
    apps.push(app)
    const { port } = await app.listen(0)
    const response = await fetch(`http://127.0.0.1:${port}/?source=pwa`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('shell')
    expect((await fetch(`http://127.0.0.1:${port}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404)
  })
})

describe('remote-control continuity', () => {
  it('keeps a run alive across a disconnect and replays the pending approval', async () => {
    const runtime = { name: 'mock' as const, async run(_prompt: string, handlers: import('./runtime').RuntimeHandlers) {
      handlers.chunk('before approval ')
      const allowed = await handlers.approve?.('write_file', { path: 'a' }, 'needs approval')
      handlers.chunk('after')
      return { allowed }
    } }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbr-cont-'))
    const app = createCompanionServer({ runtime, token: 't', stateDir: dir })
    apps.push(app)
    const { port } = await app.listen(0)
    const first = new WebSocket(`ws://127.0.0.1:${port}/ws?token=t`)
    await new Promise<void>((resolve) => first.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'ready') first.send(JSON.stringify({ type: 'chat', sessionId: m.activeSessionId, text: 'go' })); if (m.type === 'approval-request') resolve() }))
    first.terminate()
    const second = new WebSocket(`ws://127.0.0.1:${port}/ws?token=t`)
    const seen: Array<Record<string, any>> = []
    const output = await new Promise<unknown>((resolve) => second.on('message', (raw) => {
      const m = JSON.parse(raw.toString()); seen.push(m)
      if (m.type === 'approval-request') second.send(JSON.stringify({ type: 'approval', sessionId: m.sessionId, requestId: m.requestId, decision: 'approve' }))
      if (m.type === 'run-finish') resolve(m.output)
    }))
    expect(output).toEqual({ allowed: true })
    expect(seen.map((m) => m.type).slice(0, 5)).toEqual(['ready', 'user', 'run-start', 'chunk', 'approval-request'])
    second.close()
  })

  it('marks approvals left open by a cancel as denied in the replay', async () => {
    const runtime = { name: 'mock' as const, async run(_prompt: string, handlers: import('./runtime').RuntimeHandlers) {
      return { allowed: await handlers.approve?.('write_file', { path: 'a' }, 'needs approval') }
    } }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbr-cancel-'))
    const app = createCompanionServer({ runtime, token: 't', stateDir: dir })
    apps.push(app)
    const { port } = await app.listen(0)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=t`)
    const seen: Array<Record<string, any>> = []
    await new Promise<void>((resolve) => ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()); seen.push(m)
      if (m.type === 'ready') ws.send(JSON.stringify({ type: 'chat', sessionId: m.activeSessionId, text: 'go' }))
      if (m.type === 'approval-request') ws.send(JSON.stringify({ type: 'cancel', sessionId: m.sessionId }))
      if (m.type === 'approval-resolved') resolve()
    }))
    expect(seen.find((m) => m.type === 'approval-resolved')?.decision).toBe('deny')
    ws.close()
  })
})
