import os from 'node:os'
import path from 'node:path'
import { CodebuffClient, type RunState } from '@codebuff/sdk'
import { createToolOverrides } from './toolOverrides.js'
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
      overrideTools: createToolOverrides(this.projectDir, guarded, handlers.signal),
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
