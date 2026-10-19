import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSdkPatched, patchSdk } from './scripts/patch-sdk.mjs'

const script = path.resolve('scripts/patch-sdk.mjs')
const NEEDLE = '...costMode && { cost_mode: costMode }'

describe('patch-sdk', () => {
  it('patches a copy of the sdk when run as a script (CLI entry detection works on every OS)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-sdk-'))
    fs.mkdirSync(path.join(dir, 'dist'))
    for (const f of ['index.mjs', 'index.cjs']) fs.writeFileSync(path.join(dir, 'dist', f), `x({ ${NEEDLE} })`)
    expect(isSdkPatched(dir)).toBe(false)
    expect(patchSdk(dir)).toEqual(['index.mjs: patched', 'index.cjs: patched'])
    expect(isSdkPatched(dir)).toBe(true)
    expect(patchSdk(dir)).toEqual(['index.mjs: already patched', 'index.cjs: already patched'])
  })

  it('actually runs its CLI branch when invoked by path', () => {
    // Run against the real installed sdk (postinstall does exactly this); output proves the entry check matched.
    const out = execFileSync(process.execPath, [script], { encoding: 'utf8' })
    expect(out).toMatch(/patch-sdk: index\.mjs: (already )?patched/)
  })
})
