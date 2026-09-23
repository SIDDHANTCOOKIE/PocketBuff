// Regenerates freebuff-agent.json from a codebuff monorepo checkout (Apache-2.0, https://github.com/CodebuffAI/codebuff).
// Usage: node scripts/extract-freebuff-agent.mjs /path/to/codebuff
// Free mode only admits the CLI's own root agent, and checks that its system prompt opens with the canonical
// Freebuff text, so we ship that definition verbatim instead of writing our own.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(process.argv[2] || '../codebuff')
const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = path.join(os.tmpdir(), `base2-free-${process.pid}.mjs`)
execFileSync(path.join(app, 'node_modules', '.bin', 'esbuild'), [
  'agents/base2/base2-free.ts', '--bundle', '--platform=node', '--format=esm',
  '--tsconfig=agents/tsconfig.json', `--outfile=${out}`, '--log-level=error',
], { cwd: repo, stdio: 'inherit' })
const def = (await import(out)).default
fs.rmSync(out)
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo }).toString().trim()
const json = { ...def, handleSteps: def.handleSteps?.toString(), _source: `codebuff@${commit} agents/base2/base2-free.ts` }
fs.writeFileSync(path.join(app, 'freebuff-agent.json'), JSON.stringify(json, null, 2) + '\n')
console.log(`wrote freebuff-agent.json from codebuff@${commit}`)
