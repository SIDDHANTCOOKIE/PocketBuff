import { CodebuffClient, type RunState } from '@codebuff/sdk'
import { readFreebuffToken } from './auth.js'

export interface RuntimeHandlers {
  event(value: unknown): void
  chunk(value: unknown): void
}

export interface ChatRuntime {
  readonly name: 'codebuff' | 'mock'
  run(prompt: string, handlers: RuntimeHandlers): Promise<unknown>
}

export class CodebuffRuntime implements ChatRuntime {
  readonly name = 'codebuff' as const
  private client: CodebuffClient
  private previousRun?: RunState

  constructor(projectDir: string, apiKey = readFreebuffToken()) {
    this.client = new CodebuffClient({ apiKey, cwd: projectDir })
  }

  async run(prompt: string, handlers: RuntimeHandlers): Promise<unknown> {
    const result = await this.client.run({
      agent: 'base',
      prompt,
      previousRun: this.previousRun,
      costMode: 'free',
      handleEvent: handlers.event,
      handleStreamChunk: handlers.chunk,
    })
    this.previousRun = result
    return result.output
  }
}

export class MockRuntime implements ChatRuntime {
  readonly name = 'mock' as const
  async run(prompt: string, handlers: RuntimeHandlers): Promise<unknown> {
    handlers.event({ type: 'start', messageHistoryLength: 0 })
    const text = `Mock Freebuff received: ${prompt}`
    handlers.chunk(text)
    handlers.event({ type: 'text', text })
    handlers.event({ type: 'finish', totalCost: 0 })
    return { type: 'last_message', value: text }
  }
}
