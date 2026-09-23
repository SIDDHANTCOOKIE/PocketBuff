import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Reads and extends the Freebuff CLI's own chat folders so a phone can pick up a terminal session
// and `freebuff --continue` sees what the phone added. Layout mirrors codebuff cli/src/project-files.ts
// and cli/src/utils/run-state-storage.ts: <config>/projects/<basename(project)>/chats/<chatId>/
// with run-state.json (SDK RunState), chat-messages.json (UI transcript) and chat-meta.json (summary).

export type CliChatSummary = { chatId: string; firstPrompt: string; messageCount: number; updatedAt: string }
export type CliTranscriptItem = { role: 'user' | 'assistant'; text: string } | { role: 'tool'; text: string; subject: string; output: string }
type CliBlock = { type?: string; textType?: string; content?: unknown; toolName?: string; input?: unknown; output?: unknown; blocks?: CliBlock[] }
type CliMessage = { id?: string; variant?: string; content?: string; blocks?: CliBlock[]; timestamp?: string; [key: string]: unknown }

export function cliConfigDir(env = process.env) { return env.FREEBUFF_CONFIG_DIR || path.join(os.homedir(), '.config', 'manicode') }
export function cliChatsDir(projectDir: string, env = process.env) { return path.join(cliConfigDir(env), 'projects', path.basename(path.resolve(projectDir)), 'chats') }

function chatDir(projectDir: string, chatId: string) {
  // Chat ids are folder names; refuse anything that could walk out of the chats folder.
  if (!/^[\w:-][\w.:-]*$/.test(chatId)) throw new Error('Invalid chat id')
  return path.join(cliChatsDir(projectDir), chatId)
}

function readMessages(dir: string): CliMessage[] {
  try { const data = JSON.parse(fs.readFileSync(path.join(dir, 'chat-messages.json'), 'utf8')); return Array.isArray(data) ? data : [] } catch { return [] }
}

/** CLI chats for a project that can be continued (they have a saved run state), newest first. */
export function listCliChats(projectDir: string): CliChatSummary[] {
  const root = cliChatsDir(projectDir)
  let names: string[] = []; try { names = fs.readdirSync(root) } catch { return [] }
  const chats: CliChatSummary[] = []
  for (const chatId of names) {
    const dir = path.join(root, chatId)
    if (!fs.existsSync(path.join(dir, 'run-state.json'))) continue
    let meta: { firstPrompt?: string; messageCount?: number } = {}
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'chat-meta.json'), 'utf8')) } catch {
      const messages = readMessages(dir); meta = { firstPrompt: messages.find((m) => m.variant === 'user')?.content ?? '', messageCount: messages.length }
    }
    chats.push({ chatId, firstPrompt: meta.firstPrompt ?? '', messageCount: meta.messageCount ?? 0, updatedAt: fs.statSync(dir).mtime.toISOString() })
  }
  return chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

// Tools that only drive the CLI's own UI; they carry nothing a reader of the transcript needs.
const HIDDEN_TOOLS = new Set(['suggest_followups', 'end_turn', 'set_output'])

// Terminal output can be huge; the phone only needs enough to recognise what happened.
const clip = (text: string, max = 4000) => text.length > max ? text.slice(0, max) + '\n…' : text

function toolSubject(input: unknown): string {
  let value: Record<string, unknown> = {}
  try { const parsed = typeof input === 'string' ? JSON.parse(input) : input; if (parsed && typeof parsed === 'object') value = parsed as Record<string, unknown> } catch { return '' }
  const pick = (v: unknown) => Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(', ') : typeof v === 'string' ? v : ''
  return pick(value.path) || pick(value.paths) || pick(value.filePaths) || pick(value.command) || pick(value.pattern) || pick(value.query) || ''
}

/** Assistant blocks in order: replies as text, tool calls as their own entries, reasoning left out. */
function blockItems(blocks: CliBlock[] = [], out: CliTranscriptItem[] = []): CliTranscriptItem[] {
  for (const block of blocks) {
    if (block.type === 'text' && block.textType !== 'reasoning' && typeof block.content === 'string' && block.content.trim()) {
      const last = out.at(-1)
      if (last?.role === 'assistant') last.text += '\n\n' + block.content.trim(); else out.push({ role: 'assistant', text: block.content.trim() })
    } else if (block.type === 'tool' && block.toolName && !HIDDEN_TOOLS.has(block.toolName)) {
      out.push({ role: 'tool', text: block.toolName, subject: toolSubject(block.input), output: typeof block.output === 'string' ? clip(block.output) : '' })
    } else if (block.type === 'agent') blockItems(block.blocks, out)
  }
  return out
}

/** The visible conversation (user prompts and assistant replies, reasoning left out). */
export function readCliTranscript(projectDir: string, chatId: string): CliTranscriptItem[] {
  return readMessages(chatDir(projectDir, chatId)).flatMap((message): CliTranscriptItem[] => {
    if (message.variant === 'user' && message.content) return [{ role: 'user', text: message.content }]
    if (message.variant === 'ai') {
      const items = blockItems(message.blocks)
      if (message.content?.trim()) items.unshift({ role: 'assistant', text: message.content.trim() })
      return items
    }
    return []
  })
}

export function readCliRunState<T>(projectDir: string, chatId: string): T {
  return JSON.parse(fs.readFileSync(path.join(chatDir(projectDir, chatId), 'run-state.json'), 'utf8')) as T
}

function writeAtomic(file: string, text: string) { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file) }

/** Saves a phone turn back in CLI format: new run state, the two transcript entries, and a fresh summary. */
export function appendCliTurn(projectDir: string, chatId: string, runState: unknown, prompt: string, reply: string, now = new Date()) {
  const dir = chatDir(projectDir, chatId)
  const messages = readMessages(dir)
  const stamp = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  const ms = now.getTime()
  messages.push({ id: `user-${ms}`, variant: 'user', content: prompt, timestamp: stamp })
  messages.push({ id: `ai-${ms + 1}-${crypto.randomInt(1e12)}`, variant: 'ai', content: '', blocks: [{ type: 'text', textType: 'text', content: reply }], timestamp: stamp, isComplete: true, credits: 0 })
  writeAtomic(path.join(dir, 'run-state.json'), JSON.stringify(runState))
  const messagesFile = path.join(dir, 'chat-messages.json')
  writeAtomic(messagesFile, JSON.stringify(messages))
  const stats = fs.statSync(messagesFile)
  const firstPrompt = (messages.find((m) => m.variant === 'user')?.content ?? '').trim()
  writeAtomic(path.join(dir, 'chat-meta.json'), JSON.stringify({ messageCount: messages.length, firstPrompt: firstPrompt.length > 100 ? firstPrompt.slice(0, 97) + '...' : firstPrompt, messagesSize: stats.size, messagesMtimeMs: stats.mtimeMs }))
}

/** Final assistant text from an SDK run output ({ type: 'lastMessage', value: [...] }). */
export function replyText(output: unknown): string {
  const value = (output as { value?: unknown })?.value
  const messages = Array.isArray(value) ? value : []
  const texts: string[] = []
  for (const message of messages) {
    const content = (message as { content?: unknown })?.content
    if (typeof content === 'string') texts.push(content)
    else if (Array.isArray(content)) for (const part of content) if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text)
  }
  return texts.join('\n').trim()
}
