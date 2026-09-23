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
