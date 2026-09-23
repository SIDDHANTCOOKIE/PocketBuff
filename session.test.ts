import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MockRuntime } from './runtime'
import { SessionManager } from './session'

describe('session manager', () => {
  it('persists independent projects and restores them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-sessions-'))
    const file = path.join(dir, 'sessions.json')
    const make = (projectDir: string) => new MockRuntime()
    const first = new SessionManager(file, make, '/tmp/one')
    const second = first.create('Two', '/tmp/two')
    expect(first.list()).toHaveLength(2)
    const restored = new SessionManager(file, make, '/tmp/ignored')
    expect(restored.get(second.id)?.projectDir).toBe('/tmp/two')
  })
})
