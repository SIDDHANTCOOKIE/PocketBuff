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
        if (message.type === 'ready') ws.send(JSON.stringify({ type: 'chat', text: 'hello' }))
        if (message.type === 'run-finish') resolve()
      })
    })
    expect(messages.map((m) => m.type)).toEqual(expect.arrayContaining(['ready', 'run-start', 'event', 'chunk', 'run-finish']))
    expect(messages.find((m) => m.type === 'chunk')?.chunk).toContain('hello')
    ws.close()
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
