import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatRuntime } from './runtime.js'

export type SessionSummary = { id: string; name: string; projectDir: string; updatedAt: string }
export type Session = SessionSummary & { runtime: ChatRuntime }
type StoredSession = SessionSummary

export class SessionManager {
  private sessions = new Map<string, Session>()

  constructor(private file: string, private createRuntime: (projectDir: string, sessionId: string) => ChatRuntime, defaultProjectDir: string) {
    for (const item of this.read()) this.sessions.set(item.id, { ...item, runtime: createRuntime(item.projectDir, item.id) })
    if (this.sessions.size === 0) this.create(path.basename(defaultProjectDir) || 'Project', defaultProjectDir)
  }

  list(): SessionSummary[] { return [...this.sessions.values()].map(({ runtime: _runtime, ...summary }) => summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }
  get(id: string): Session | undefined { return this.sessions.get(id) }
  create(name: string, projectDir: string): Session {
    const id = crypto.randomUUID()
    const session: Session = { id, name: name.trim() || path.basename(projectDir), projectDir: path.resolve(projectDir), updatedAt: new Date().toISOString(), runtime: this.createRuntime(path.resolve(projectDir), id) }
    this.sessions.set(id, session); this.save(); return session
  }
  touch(id: string) { const session = this.sessions.get(id); if (session) { session.updatedAt = new Date().toISOString(); this.save() } }
  delete(id: string): boolean { const deleted = this.sessions.delete(id); if (deleted) this.save(); return deleted }

  private read(): StoredSession[] { try { const data = JSON.parse(fs.readFileSync(this.file, 'utf8')); return Array.isArray(data) ? data : [] } catch { return [] } }
  private save() { fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); const tmp = `${this.file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.list(), null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file) }
}
