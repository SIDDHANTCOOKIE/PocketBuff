// Regenerates freebuff-agents.json from a codebuff monorepo checkout (Apache-2.0, https://github.com/CodebuffAI/codebuff).
// Usage: node scripts/extract-freebuff-agent.mjs /path/to/codebuff
// The codebuff checkout needs its dependencies installed (or NODE_PATH pointing at lodash and zod) for the bundle step.
// Free mode only admits the CLI's own root agent, and checks that its system prompt opens with the canonical
// Freebuff text, so we ship that definition verbatim instead of writing our own.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(process.argv[2] || '../codebuff')
const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// The CLI's own base3 roots, one per zero-cost-capable model (codebuff FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL).
const ROOTS = ['base3-free-glm-5-3-flash', 'base3-free-mimo', 'base3-free-solar-pro4', 'base3-free-deepseek-flash', 'base3-free-deepseek', 'base3-free-luna']
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo }).toString().trim()
const byModel = {}
for (const id of ROOTS) {
  const out = path.join(os.tmpdir(), `${id}-${process.pid}.mjs`)
  execFileSync(path.join(app, 'node_modules', '.bin', 'esbuild'), [
    `agents/${id}.ts`, '--bundle', '--platform=node', '--format=esm',
    '--tsconfig=agents/tsconfig.json', `--outfile=${out}`, '--log-level=error',
  ], { cwd: repo, stdio: 'inherit' })
  const def = (await import(out)).default
  fs.rmSync(out)
  byModel[def.model] = { ...def, handleSteps: def.handleSteps?.toString() }
}
fs.writeFileSync(path.join(app, 'freebuff-agents.json'), JSON.stringify({ _source: `codebuff@${commit} agents/base3-free-*.ts`, byModel }, null, 2) + '\n')
console.log(`wrote freebuff-agents.json (${Object.keys(byModel).join(', ')}) from codebuff@${commit}`)
