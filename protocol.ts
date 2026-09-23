export type ApprovalDecision = 'approve' | 'deny'

export type ClientMessage =
  | { type: 'chat'; text: string }
  | { type: 'approval'; requestId: string; decision: ApprovalDecision }
  | { type: 'cancel' }
  | { type: 'ping' }

export type ToolCard = {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'running' | 'succeeded' | 'failed'
  output?: unknown
}

export type ServerMessage =
  | { type: 'ready'; projectDir: string; runtime: 'codebuff' | 'mock' }
  | { type: 'run-start' }
  | { type: 'event'; event: unknown }
  | { type: 'chunk'; chunk: unknown }
  | { type: 'tool'; tool: ToolCard }
  | { type: 'diff'; toolCallId: string; patch: string }
  | { type: 'approval-request'; requestId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; reason: string }
  | { type: 'approval-resolved'; requestId: string; decision: ApprovalDecision }
  | { type: 'run-finish'; output: unknown }
  | { type: 'run-cancelled' }
  | { type: 'error'; message: string }
  | { type: 'pong' }
