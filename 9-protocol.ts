export type ClientMessage =
  | { type: 'chat'; text: string }
  | { type: 'ping' }

export type ServerMessage =
  | { type: 'ready'; projectDir: string; runtime: 'codebuff' | 'mock' }
  | { type: 'run-start' }
  | { type: 'event'; event: unknown }
  | { type: 'chunk'; chunk: unknown }
  | { type: 'run-finish'; output: unknown }
  | { type: 'error'; message: string }
  | { type: 'pong' }
