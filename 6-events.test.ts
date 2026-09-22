import { describe, expect, it } from 'vitest'
import { messagesForEvent } from './events'
import type { ToolCard } from './protocol'

describe('typed tool events', () => {
  it('maps calls and results into one stable card', () => {
    const cards = new Map<string, ToolCard>()
    expect(messagesForEvent({ type: 'tool_call', toolCallId: '1', toolName: 'read_files', input: { filePaths: ['a'] } }, cards)[0]).toMatchObject({ type: 'tool', tool: { status: 'running' } })
    expect(messagesForEvent({ type: 'tool_result', toolCallId: '1', output: [{ type: 'text', text: 'ok' }] }, cards)[0]).toMatchObject({ type: 'tool', tool: { status: 'succeeded' } })
  })
})
