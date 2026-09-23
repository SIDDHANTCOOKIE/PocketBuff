import { execSync } from 'node:child_process'
import fs from 'node:fs'

// The static-asset tests serve dist/client, so a fresh clone builds it once before `npm test`.
export default function setup() {
  if (!fs.existsSync('dist/client/index.html')) execSync('npx vite build', { stdio: 'ignore' })
}
