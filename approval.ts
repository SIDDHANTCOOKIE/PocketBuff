import crypto from 'node:crypto'
import type { ApprovalDecision } from './protocol.js'

export type ApprovalRequest = {
  requestId: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  reason: string
}

type Pending = ApprovalRequest & { resolve(decision: ApprovalDecision): void }

const SENSITIVE_TOOLS = new Set(['run_terminal_command', 'write_file', 'change_file', 'apply_patch', 'delete_file'])

export function approvalReason(toolName: string, input: Record<string, unknown>): string | null {
  if (SENSITIVE_TOOLS.has(toolName)) return `${toolName} can change the project or run a local command.`
  if (toolName === 'read_files') {
    const paths = Array.isArray(input.filePaths) ? input.filePaths : []
    if (paths.some((value) => typeof value === 'string' && /(^|\/)\.env(\.|$)|\.pem$|\.key$/i.test(value))) return 'Reading a sensitive credential-like file needs approval.'
  }
  return null
}

export class ApprovalGate {
  private pending = new Map<string, Pending>()

  request(toolCallId: string, toolName: string, input: Record<string, unknown>, reason: string, notify: (request: ApprovalRequest) => void) {
    const request: ApprovalRequest = { requestId: crypto.randomUUID(), toolCallId, toolName, input, reason }
    const decision = new Promise<ApprovalDecision>((resolve) => this.pending.set(request.requestId, { ...request, resolve }))
    notify(request)
    return { request, decision }
  }

  resolve(requestId: string, decision: ApprovalDecision): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    this.pending.delete(requestId)
    pending.resolve(decision)
    return true
  }

  clear(decision: ApprovalDecision = 'deny') {
    for (const pending of this.pending.values()) pending.resolve(decision)
    this.pending.clear()
  }
}
