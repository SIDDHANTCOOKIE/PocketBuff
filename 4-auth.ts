import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

interface CredentialsFile {
  default?: { authToken?: string }
}

export function credentialsPath(env = process.env): string {
  const configDir = env.FREEBUFF_CONFIG_DIR || path.join(os.homedir(), '.config', 'manicode')
  return path.join(configDir, 'credentials.json')
}

export function readFreebuffToken(env = process.env): string {
  if (env.CODEBUFF_API_KEY) return env.CODEBUFF_API_KEY
  const file = credentialsPath(env)
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as CredentialsFile
    if (data.default?.authToken) return data.default.authToken
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid Freebuff credentials JSON at ${file}`)
  }
  throw new Error(`No Freebuff login found. Run freebuff and log in first (looked in ${file}).`)
}
