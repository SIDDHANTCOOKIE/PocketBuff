import { describe, expect, it } from 'vitest'
import { ApprovalGate, approvalReason } from './approval'

describe('approval gate', () => {
  it('classifies mutating tools and sensitive reads', () => {
    expect(approvalReason('run_terminal_command', {})).toContain('local command')
    expect(approvalReason('read_files', { filePaths: ['.env'] })).toContain('sensitive')
    expect(approvalReason('read_files', { filePaths: ['README.md'] })).toBeNull()
  })
  it('pauses until approved or denied', async () => {
    const gate = new ApprovalGate()
    const { request, decision } = gate.request('tool-1', 'run_terminal_command', {}, 'reason', () => {})
    expect(gate.resolve(request.requestId, 'approve')).toBe(true)
    await expect(decision).resolves.toBe('approve')
  })
})
