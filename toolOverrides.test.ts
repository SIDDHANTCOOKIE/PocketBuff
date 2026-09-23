import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPatch } from 'diff'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createCompanionServer } from './server'
import { approvalReason } from './approval'
import { createToolOverrides } from './toolOverrides'
import type { RuntimeHandlers } from './runtime'

const apps: ReturnType<typeof createCompanionServer>[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })

function hunkPatch(name: string, before: string, after: string) {
  const lines = createPatch(name, before, after).split('\n')
  return lines.slice(lines.findIndex((line) => line.startsWith('@@'))).join('\n')
}

// Mirrors how @codebuff/sdk dispatches client tools: str_replace arrives at the write_file override as a hunk patch.
function sdkShapedRuntime(projectDir: string) {
  return { name: 'mock' as const, async run(_prompt: string, handlers: RuntimeHandlers) {
    const guarded = async (toolName: string, input: Record<string, unknown>) => { const reason = approvalReason(toolName, input); return !reason || await handlers.approve?.(toolName, input, reason) === true }
    const overrides = createToolOverrides(projectDir, guarded, handlers.signal)
    const input = { type: 'patch', path: 'a.txt', content: hunkPatch('a.txt', 'one\ntwo\n', 'one\nTWO\n') }
    handlers.event({ type: 'tool_call', toolCallId: 't1', toolName: 'str_replace', input })
    const output = await overrides.write_file(input)
    handlers.event({ type: 'tool_result', toolCallId: 't1', toolName: 'str_replace', output })
    return output
  } }
}

async function drive(decision: 'approve' | 'deny') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbr-'))
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n')
  const app = createCompanionServer({ runtime: sdkShapedRuntime(dir), token: 't', stateDir: path.join(dir, '.state') })
  apps.push(app)
  const { port } = await app.listen(0)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=t`)
  const messages: Array<Record<string, any>> = []
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject)
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()); messages.push(message)
      if (message.type === 'ready') ws.send(JSON.stringify({ type: 'chat', sessionId: message.activeSessionId, text: 'edit' }))
      if (message.type === 'approval-request') ws.send(JSON.stringify({ type: 'approval', sessionId: message.sessionId, requestId: message.requestId, decision }))
      if (message.type === 'run-finish') resolve()
    })
  })
  ws.close()
  return { dir, messages, file: fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') }
}

describe('SDK-shaped edits through the approval gate', () => {
  it('applies an approved str_replace patch and shows a real diff', async () => {
    const { messages, file } = await drive('approve')
    expect(file).toBe('one\nTWO\n')
    expect(messages.find((m) => m.type === 'approval-request')?.input).toMatchObject({ type: 'patch', path: 'a.txt' })
    expect(messages.find((m) => m.type === 'diff')?.patch).toContain('+TWO')
    expect(messages.filter((m) => m.type === 'tool').at(-1)?.tool.status).toBe('succeeded')
  })

  it('leaves the file untouched when denied', async () => {
    const { messages, file } = await drive('deny')
    expect(file).toBe('one\ntwo\n')
    expect(messages.some((m) => m.type === 'diff')).toBe(false)
    expect(messages.filter((m) => m.type === 'tool').at(-1)?.tool.status).toBe('failed')
  })

  it('keeps terminal commands inside the project and reports apply_patch clearly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbr-'))
    const overrides = createToolOverrides(dir, async () => true)
    expect(JSON.stringify(await overrides.run_terminal_command({ command: 'pwd', cwd: '..', process_type: 'SYNC', timeout_seconds: 5 }))).toContain('inside the project')
    expect(JSON.stringify(await overrides.run_terminal_command({ command: 'echo remote-ok', process_type: 'SYNC', timeout_seconds: 5 }))).toContain('remote-ok')
    expect(JSON.stringify(await overrides.write_file({ operation: { type: 'update_file', path: 'a', diff: 'x' } }))).toContain('apply_patch is not supported')
    expect(JSON.stringify(await overrides.write_file({ type: 'file', path: '../escape.txt', content: 'x' }))).toContain('out-of-project')
  })
})
