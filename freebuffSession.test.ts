import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FreebuffSlotClient } from './freebuffSession'

type Call = { method: string; url: string; headers: Record<string, string> }
function fakeServer(responses: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    const call = { method: init.method ?? 'GET', url, headers: init.headers as Record<string, string> }; calls.push(call)
    const key = `${call.method} ${new URL(url).pathname}`
    const handler = responses[key]; if (!handler) throw new Error(`unexpected ${key}`)
    const { status = 200, body } = handler(call)
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}
const stateFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-slot-')), 'slot.json')
const later = new Date(Date.now() + 3_600_000).toISOString()
const prices = { freebucks: { prices: { 'mimo/mimo-v2.5': 0, 'deepseek/deepseek-v4-flash': 5 } } }

describe('Freebuff slot client', () => {
  it('admits a zero-cost model, persists the slot and sends the auth and model headers', async () => {
    const server = fakeServer({
      'GET /api/v1/freebuff/session': () => ({ body: { status: 'none', ...prices } }),
      'POST /api/v1/freebuff/session/admission': () => ({ body: { status: 'active', instanceId: 'inst-1', model: 'mimo/mimo-v2.5', expiresAt: later } }),
    })
    const file = stateFile()
    const slot = await new FreebuffSlotClient({ token: 'tok', stateFile: file, fetch: server.fetch }).ensure()
    expect(slot).toMatchObject({ instanceId: 'inst-1', model: 'mimo/mimo-v2.5', agentId: 'base2-free' })
    const post = server.calls.find((call) => call.method === 'POST')!
    expect(post.headers).toMatchObject({ Authorization: 'Bearer tok', 'x-freebuff-model': 'mimo/mimo-v2.5', 'x-freebuff-wallet-spend-limit': '0' })
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).instanceId).toBe('inst-1')
  })

  it('refuses to claim a slot that costs Freebucks unless allowed', async () => {
    const server = fakeServer({ 'GET /api/v1/freebuff/session': () => ({ body: { status: 'none', ...prices } }) })
    const client = new FreebuffSlotClient({ token: 'tok', stateFile: stateFile(), model: 'deepseek/deepseek-v4-flash', fetch: server.fetch })
    await expect(client.ensure()).rejects.toThrow(/costs 5 Freebucks.*mimo\/mimo-v2.5/)
    expect(server.calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('reuses a saved live slot after checking it with the server, then releases it', async () => {
    const file = stateFile()
    fs.writeFileSync(file, JSON.stringify({ instanceId: 'inst-9', model: 'mimo/mimo-v2.5', agentId: 'base2-free', expiresAt: later }))
    const server = fakeServer({
      'GET /api/v1/freebuff/session': (call) => ({ body: { status: 'active', instanceId: call.headers['x-freebuff-instance-id'] } }),
      'DELETE /api/v1/freebuff/session': () => ({ body: { status: 'none' } }),
    })
    const client = new FreebuffSlotClient({ token: 'tok', stateFile: file, fetch: server.fetch })
    const [a, b] = await Promise.all([client.ensure(), client.ensure()])
    expect(a.instanceId).toBe('inst-9'); expect(b).toBe(a)
    await client.ensure()
    expect(server.calls.filter((call) => call.method === 'GET')).toHaveLength(1)
    await client.release()
    expect(server.calls.at(-1)).toMatchObject({ method: 'DELETE', headers: { 'x-freebuff-instance-id': 'inst-9' } })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('reports a typed refusal from admission', async () => {
    const server = fakeServer({
      'GET /api/v1/freebuff/session': () => ({ body: { status: 'none', ...prices } }),
      'POST /api/v1/freebuff/session/admission': () => ({ status: 409, body: { status: 'model_locked', message: 'Finish your current session first' } }),
    })
    await expect(new FreebuffSlotClient({ token: 'tok', stateFile: stateFile(), fetch: server.fetch }).ensure()).rejects.toThrow('Freebuff did not admit a session: model_locked - Finish your current session first')
  })
})
