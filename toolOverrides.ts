import fs from 'node:fs/promises'
import path from 'node:path'
import { ToolHelpers, type ClientToolCall } from '@codebuff/sdk'
import { applyPatch, createTwoFilesPatch } from 'diff'

type Guard = (toolName: string, input: Record<string, unknown>) => Promise<boolean>
type Output = [{ type: 'json'; value: Record<string, unknown> }]
const fail = (errorMessage: string): Output => [{ type: 'json', value: { errorMessage } }]

function inside(root: string, target: string) { return target === root || target.startsWith(root + path.sep) }

export function createToolOverrides(projectDir: string, guarded: Guard, signal?: AbortSignal) {
  const root = path.resolve(projectDir)
  return {
    run_terminal_command: async (input: ClientToolCall<'run_terminal_command'>['input']) => {
      // Validate before asking, so the phone is never asked to approve something that will be rejected anyway.
      const cwd = path.resolve(root, input.cwd ?? '.')
      if (!inside(root, cwd)) return fail('Terminal cwd must stay inside the project.')
      if (!await guarded('run_terminal_command', input as Record<string, unknown>)) return fail('Denied by remote user.')
      if (signal?.aborted) return fail('Run was cancelled.')
      return ToolHelpers.runTerminalCommand({ ...input, cwd })
    },
    // The SDK routes write_file and str_replace here as { type: 'file' | 'patch', path, content }.
    write_file: async (input: Record<string, unknown>) => {
      const relative = typeof input.path === 'string' ? input.path : ''
      const target = path.resolve(root, relative)
      if (!relative || !inside(root, target) || target === root || typeof input.content !== 'string') {
        return fail(input.operation ? 'apply_patch is not supported by Freebuff Remote; use str_replace or write_file.' : 'Invalid or out-of-project file path.')
      }
      if (!await guarded('write_file', input)) return fail('Denied by remote user.')
      const before = await fs.readFile(target, 'utf8').catch(() => null)
      let after = input.content
      if (input.type === 'patch') {
        if (before === null) return fail('Patch target does not exist.')
        const changed = applyPatch(before, input.content)
        if (changed === false) return fail('Patch did not apply.')
        after = changed
      }
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, after)
      const unifiedDiff = createTwoFilesPatch(`a/${relative}`, `b/${relative}`, before ?? '', after)
      return [{ type: 'json', value: { file: relative, message: before === null ? 'Created new file' : 'Updated file', unifiedDiff } }] as Output
    },
  }
}
