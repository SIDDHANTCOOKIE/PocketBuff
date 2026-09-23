import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readFreebuffToken } from './auth'

describe('Freebuff auth reuse', () => {
  it('reads the CLI credentials without asking for a paid SDK key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-auth-'))
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ default: { authToken: 'cli-login-token' } }))
    expect(readFreebuffToken({ FREEBUFF_CONFIG_DIR: dir } as NodeJS.ProcessEnv)).toBe('cli-login-token')
  })
})
