import type { ServerMessage, ToolCard } from './protocol.js'
type SessionServerMessage = Extract<ServerMessage, { sessionId: string }>
type RuntimeMessage = SessionServerMessage extends infer M ? M extends { sessionId: string } ? Omit<M, 'sessionId'> : never : never

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

export function messagesForEvent(value: unknown, tools: Map<string, ToolCard>): RuntimeMessage[] {
  const event = record(value)
  if (!event || typeof event.type !== 'string') return [{ type: 'event', event: value }]
  if (event.type === 'tool_call' && typeof event.toolCallId === 'string' && typeof event.toolName === 'string') {
    const tool: ToolCard = { id: event.toolCallId, name: event.toolName, input: record(event.input) ?? {}, status: 'running' }
    tools.set(tool.id, tool)
    return [{ type: 'tool', tool }]
  }
  if (event.type === 'tool_result' && typeof event.toolCallId === 'string') {
    const prior = tools.get(event.toolCallId)
    if (!prior) return [{ type: 'event', event: value }]
    const output = event.output
    const failed = JSON.stringify(output).toLowerCase().includes('error')
    const tool: ToolCard = { ...prior, status: failed ? 'failed' : 'succeeded', output }
    tools.set(tool.id, tool)
    const messages: RuntimeMessage[] = [{ type: 'tool', tool }]
    if (/change_file|apply_patch|write_file/.test(tool.name)) {
      const patch = JSON.stringify(output, null, 2)
      messages.push({ type: 'diff', toolCallId: tool.id, patch })
    }
    return messages
  }
  return [{ type: 'event', event: value }]
}
