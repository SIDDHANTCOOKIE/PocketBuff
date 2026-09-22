import fs from 'node:fs'
import path from 'node:path'

export class CheckpointStore<T> {
  constructor(private file: string) {}
  load(): T | undefined {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) as T } catch { return undefined }
  }
  save(value: T) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
    fs.renameSync(temporary, this.file)
  }
}
