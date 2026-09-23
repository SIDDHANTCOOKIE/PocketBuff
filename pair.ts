import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** One-time pairing: a 6-digit code, valid for a few minutes and a few tries, that a phone trades for the long-lived token. */
export const PAIR_TTL_MS = 10 * 60 * 1000
export const PAIR_MAX_ATTEMPTS = 5
interface PairingFile { hash: string; expiresAt: number; attempts: number }
const hash = (code: string) => crypto.createHash('sha256').update(code).digest('hex')
export const defaultStateDir = () => path.join(os.homedir(), '.config', 'freebuff-remote')
const file = (stateDir: string) => path.join(stateDir, 'pairing.json')

export function createPairingCode(stateDir = defaultStateDir(), now = Date.now()) {
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const data: PairingFile = { hash: hash(code), expiresAt: now + PAIR_TTL_MS, attempts: 0 }
  fs.writeFileSync(file(stateDir), JSON.stringify(data), { mode: 0o600 })
  return { code, expiresAt: data.expiresAt }
}

/** True once, for the right unexpired code. Wrong guesses count against the code; the last one burns it. */
export function redeemPairingCode(code: string, stateDir = defaultStateDir(), now = Date.now()): boolean {
  let data: PairingFile
  try { data = JSON.parse(fs.readFileSync(file(stateDir), 'utf8')) as PairingFile } catch { return false }
  const burn = () => fs.rmSync(file(stateDir), { force: true })
  if (now > data.expiresAt) { burn(); return false }
  const supplied = Buffer.from(hash(String(code).trim())), expected = Buffer.from(data.hash)
  if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) { burn(); return true }
  data.attempts++
  if (data.attempts >= PAIR_MAX_ATTEMPTS) burn(); else fs.writeFileSync(file(stateDir), JSON.stringify(data), { mode: 0o600 })
  return false
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const { code, expiresAt } = createPairingCode(process.env.FREEBUFF_REMOTE_STATE_DIR || defaultStateDir())
  const minutes = Math.round((expiresAt - Date.now()) / 60000)
  console.log(`CODE ${code}`)
  console.log(`EXPIRES_MINUTES ${minutes}`)
}
