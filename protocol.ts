export type ApprovalDecision = 'approve' | 'deny'
export type SessionSummary = { id: string; name: string; projectDir: string; updatedAt: string }

export type ClientMessage =
  | { type: 'chat'; sessionId: string; text: string }
  | { type: 'approval'; sessionId: string; requestId: string; decision: ApprovalDecision }
  | { type: 'cancel'; sessionId: string }
  | { type: 'session-create'; name: string; projectDir: string }
  | { type: 'session-select'; sessionId: string }
  | { type: 'session-delete'; sessionId: string }
  | { type: 'ping' }

export type ToolCard = { id: string; name: string; input: Record<string, unknown>; status: 'running' | 'succeeded' | 'failed'; output?: unknown }

export type ServerMessage =
  | { type: 'ready'; runtime: 'codebuff' | 'mock'; sessions: SessionSummary[]; activeSessionId: string }
  | { type: 'sessions'; sessions: SessionSummary[]; activeSessionId: string }
  | { type: 'run-start'; sessionId: string }
  | { type: 'event'; sessionId: string; event: unknown }
  | { type: 'chunk'; sessionId: string; chunk: unknown }
  | { type: 'tool'; sessionId: string; tool: ToolCard }
  | { type: 'diff'; sessionId: string; toolCallId: string; patch: string }
  | { type: 'approval-request'; sessionId: string; requestId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; reason: string }
  | { type: 'approval-resolved'; sessionId: string; requestId: string; decision: ApprovalDecision }
  | { type: 'run-finish'; sessionId: string; output: unknown }
  | { type: 'run-cancelled'; sessionId: string }
  | { type: 'error'; message: string }
  | { type: 'pong' }
