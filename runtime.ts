import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CodebuffClient, ToolHelpers, type RunState } from '@codebuff/sdk'
import { applyPatch } from 'diff'
import { readFreebuffToken } from './auth.js'
import { CheckpointStore } from './checkpoint.js'
import { approvalReason } from './approval.js'

export interface RuntimeHandlers {
  event(value: unknown): void
  chunk(value: unknown): void
  signal?: AbortSignal
  approve?(toolName: string, input: Record<string, unknown>, reason: string): Promise<boolean>
}

export interface ChatRuntime {
  readonly name: 'codebuff' | 'mock'
  run(prompt: string, handlers: RuntimeHandlers): Promise<unknown>
}

export class CodebuffRuntime implements ChatRuntime {
  readonly name = 'codebuff' as const
  private previousRun?: RunState
  private store: CheckpointStore<RunState>

  constructor(private projectDir: string, private apiKey = readFreebuffToken(), checkpointFile = process.env.FREEBUFF_CHECKPOINT || path.join(os.homedir(), '.config', 'freebuff-remote', 'run-state.json')) {
    this.store = new CheckpointStore(checkpointFile)
    this.previousRun = this.store.load()
  }

  async run(prompt: string, handlers: RuntimeHandlers): Promise<unknown> {
    const guarded = async (toolName: string, input: Record<string, unknown>) => {
      const reason = approvalReason(toolName, input)
      return !reason || await handlers.approve?.(toolName, input, reason) === true
    }
    const client = new CodebuffClient({
      apiKey: this.apiKey,
      cwd: this.projectDir,
      overrideTools: {
        run_terminal_command: async (input) => {
          if (!await guarded('run_terminal_command', input)) return [{ type: 'json', value: { errorMessage: 'Denied by remote user.' } }]
          return ToolHelpers.runTerminalCommand({ ...input, cwd: path.resolve(this.projectDir, input.cwd ?? '.'), signal: handlers.signal })
        },
        write_file: async (input) => {
          if (!await guarded('write_file', input)) return [{ type: 'json', value: { errorMessage: 'Denied by remote user.' } }]
          const relative = typeof input.path === 'string' ? input.path : ''
          const target = path.resolve(this.projectDir, relative)
          const root = path.resolve(this.projectDir) + path.sep
          if (!target.startsWith(root) || typeof input.content !== 'string') return [{ type: 'json', value: { errorMessage: 'Invalid or out-of-project file path.' } }]
          await fs.mkdir(path.dirname(target), { recursive: true })
          if (input.type === 'patch') {
            const current = await fs.readFile(target, 'utf8')
            const changed = applyPatch(current, input.content)
            if (changed === false) return [{ type: 'json', value: { errorMessage: 'Patch did not apply.' } }]
            await fs.writeFile(target, changed)
          } else await fs.writeFile(target, input.content)
          return [{ type: 'json', value: { file: relative, message: 'Approved file change applied.' } }]
        },
      },
    })
    const result = await client.run({
      agent: 'base', prompt, previousRun: this.previousRun, costMode: 'free',
      handleEvent: handlers.event, handleStreamChunk: handlers.chunk, signal: handlers.signal,
    })
    this.previousRun = result
    this.store.save(result)
    return result.output
  }
}

export class MockRuntime implements ChatRuntime {
  readonly name = 'mock' as const
  async run(prompt: string, handlers: RuntimeHandlers): Promise<unknown> {
    handlers.event({ type: 'start', messageHistoryLength: 0 })
    handlers.event({ type: 'tool_call', toolCallId: 'mock-tool', toolName: 'read_files', input: { filePaths: ['README.md'] } })
    handlers.event({ type: 'tool_result', toolCallId: 'mock-tool', toolName: 'read_files', output: [{ type: 'text', text: 'README' }] })
    const text = `Mock Freebuff received: ${prompt}`
    handlers.chunk(text)
    handlers.event({ type: 'text', text })
    handlers.event({ type: 'finish', totalCost: 0 })
    return { type: 'last_message', value: text }
  }
}
