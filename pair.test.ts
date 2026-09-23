import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCompanionServer } from './server.js'
import { MockRuntime } from './runtime.js'
import { PAIR_MAX_ATTEMPTS, PAIR_TTL_MS, createPairingCode, redeemPairingCode } from './pair.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fb-pair-'))

describe('pairing codes', () => {
  it('redeems the right code exactly once', () => {
    const dir = tmp(); const { code } = createPairingCode(dir)
    expect(code).toMatch(/^\d{6}$/)
    expect(redeemPairingCode(code, dir)).toBe(true)
    expect(redeemPairingCode(code, dir)).toBe(false)
  })
  it('stores only a hash, readable by the owner only', () => {
    const dir = tmp(); const { code } = createPairingCode(dir)
    const file = path.join(dir, 'pairing.json')
    expect(fs.readFileSync(file, 'utf8')).not.toContain(code)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
  it('expires', () => {
    const dir = tmp(); const now = Date.now(); const { code } = createPairingCode(dir, now)
    expect(redeemPairingCode(code, dir, now + PAIR_TTL_MS + 1)).toBe(false)
  })
  it('burns the code after too many wrong guesses', () => {
    const dir = tmp(); const { code } = createPairingCode(dir)
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 0; i < PAIR_MAX_ATTEMPTS; i++) expect(redeemPairingCode(wrong, dir)).toBe(false)
    expect(redeemPairingCode(code, dir)).toBe(false)
  })
})

describe('POST /pair', () => {
  const apps: Array<{ close(): Promise<void> }> = []
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })
  it('trades a valid code for the token and rejects a replay', async () => {
    const stateDir = tmp()
    const app = createCompanionServer({ runtime: new MockRuntime(), token: 'long-lived-token', stateDir, projectDir: tmp() }); apps.push(app)
    const { port } = await app.listen(0)
    const { code } = createPairingCode(stateDir)
    const post = (body: string) => fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    const ok = await post(JSON.stringify({ code }))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ token: 'long-lived-token' })
    expect((await post(JSON.stringify({ code }))).status).toBe(401)
    expect((await post('not json')).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${port}/pair`)).status).toBe(405)
  })
})
