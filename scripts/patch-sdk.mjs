// Adds per-request Freebuff metadata to @codebuff/sdk 0.10.7.
// Free mode needs `freebuff_instance_id` (the admitted session slot) in codebuff_metadata on every model call.
// The published SDK has no way to pass it, so we splice in a read of globalThis.__freebuffRemoteMetadata.
// Idempotent: safe to run on every install.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const MARKER = '/*freebuff-remote-metadata*/'
const NEEDLE = '...costMode && { cost_mode: costMode }'
const INSERT = `${NEEDLE},\n        ${MARKER}...globalThis.__freebuffRemoteMetadata`

export function patchSdk(sdkDir) {
  const results = []
  for (const file of ['index.mjs', 'index.cjs']) {
    const target = path.join(sdkDir, 'dist', file)
    const source = fs.readFileSync(target, 'utf8')
    if (source.includes(MARKER)) { results.push(`${file}: already patched`); continue }
    const count = source.split(NEEDLE).length - 1
    if (count !== 1) throw new Error(`@codebuff/sdk ${file}: expected 1 metadata site, found ${count}. SDK version changed; update scripts/patch-sdk.mjs.`)
    fs.writeFileSync(target, source.replace(NEEDLE, INSERT))
    results.push(`${file}: patched`)
  }
  return results
}

export function sdkDir() {
  const require = createRequire(import.meta.url)
  return path.dirname(path.dirname(require.resolve('@codebuff/sdk')))
}

export function isSdkPatched(dir = sdkDir()) {
  return ['index.mjs', 'index.cjs'].every((file) => fs.readFileSync(path.join(dir, 'dist', file), 'utf8').includes(MARKER))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const line of patchSdk(sdkDir())) console.log(`patch-sdk: ${line}`)
}
