import os from 'node:os'
import path from 'node:path'
import { CodebuffClient, type AgentDefinition, type RunState } from '@codebuff/sdk'
import { createToolOverrides } from './toolOverrides.js'
import { readFreebuffToken } from './auth.js'
import { CheckpointStore } from './checkpoint.js'
import { approvalReason } from './approval.js'
import { FreebuffSlotClient } from './freebuffSession.js'
import { isSdkPatched, sdkDir } from './scripts/patch-sdk.mjs'
import freebuffAgent from './freebuff-agent.json' with { type: 'json' }

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

  constructor(private projectDir: string, private apiKey = readFreebuffToken(), checkpointFile = process.env.FREEBUFF_CHECKPOINT || path.join(os.homedir(), '.config', 'freebuff-remote', 'run-state.json'), private slots = defaultSlotClient(apiKey)) {
    // Without the metadata patch every free-mode call is refused, so fail at startup with the fix instead.
    if (!isSdkPatched(sdkDir())) throw new Error('@codebuff/sdk is not patched for Freebuff free mode. Run: node scripts/patch-sdk.mjs')
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
    const slot = await this.slots.ensure()
    // Read by the patched SDK when it builds codebuff_metadata for each model call.
    ;(globalThis as { __freebuffRemoteMetadata?: Record<string, string> }).__freebuffRemoteMetadata = { freebuff_instance_id: slot.instanceId }
    // handleSteps ships as source text; the SDK accepts that form and evaluates it the same way it does functions.
    const { _source: _ignored, ...definition } = freebuffAgent
    const result = await client.run({
      agent: slot.agentId, agentDefinitions: [{ ...definition, id: slot.agentId, model: slot.model } as unknown as AgentDefinition],
      prompt, previousRun: this.previousRun, costMode: 'free',
      handleEvent: handlers.event, handleStreamChunk: handlers.chunk, signal: handlers.signal,
    })
    // The SDK reports backend failures (403s, gate refusals) as an error output instead of throwing.
    const output = result.output as { type?: string; message?: string } | undefined
    if (output?.type === 'error') {
      if (/instance|session|free_mode|forbidden/i.test(output.message ?? '')) this.slots.invalidate()
      throw new Error(firstLine(output.message) || 'Freebuff run failed')
    }
    this.previousRun = result
    this.store.save(result)
    return result.output
  }
}

// One slot per Freebuff account, so every session in the process must share one client.
let sharedSlots: FreebuffSlotClient | undefined
export function defaultSlotClient(token: string, stateDir = path.join(os.homedir(), '.config', 'freebuff-remote')) {
  sharedSlots ??= new FreebuffSlotClient({ token, stateFile: path.join(stateDir, 'slot.json'), model: process.env.FREEBUFF_MODEL, allowFreebucks: process.env.FREEBUFF_ALLOW_FREEBUCKS === '1' })
  return sharedSlots
}
export function releaseSharedSlot() { return sharedSlots?.release() ?? Promise.resolve() }

function firstLine(text?: string) { return (text ?? '').split('\n').find((line) => line.trim())?.trim() ?? '' }

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
