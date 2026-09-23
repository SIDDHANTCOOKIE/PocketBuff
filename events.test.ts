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

describe('tool failure detection', () => {
  it('does not mark a successful edit failed because the diff mentions error', () => {
    const cards = new Map<string, ToolCard>()
    messagesForEvent({ type: 'tool_call', toolCallId: '2', toolName: 'str_replace', input: {} }, cards)
    const ok = messagesForEvent({ type: 'tool_result', toolCallId: '2', output: [{ type: 'json', value: { file: 'a', unifiedDiff: '+throw new Error()' } }] }, cards)
    expect(ok[0]).toMatchObject({ tool: { status: 'succeeded' } })
    expect(ok[1]).toMatchObject({ type: 'diff', patch: '+throw new Error()' })
    messagesForEvent({ type: 'tool_call', toolCallId: '3', toolName: 'write_file', input: {} }, cards)
    expect(messagesForEvent({ type: 'tool_result', toolCallId: '3', output: [{ type: 'json', value: { errorMessage: 'Denied' } }] }, cards)[0]).toMatchObject({ tool: { status: 'failed' } })
  })
})
