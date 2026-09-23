import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Tailscale setup documentation', () => {
  it('keeps the companion local and proxies it through Serve', () => {
    const readme = fs.readFileSync('README.md', 'utf8')
    expect(readme).toContain('tailscale serve --bg http://127.0.0.1:8787')
    expect(readme).toContain('tailscale serve status')
  })
})
