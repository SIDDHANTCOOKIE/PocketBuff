import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendCliTurn, listCliChats, readCliRunState, readCliTranscript, replyText } from './cliChats'

let config: string
const project = '/work/demo-project'
const chatDir = (id: string) => path.join(config, 'projects', 'demo-project', 'chats', id)
function makeChat(id: string, messages: unknown[], runState: unknown = { sessionState: { mainAgentState: { messageHistory: [] } } }) {
  fs.mkdirSync(chatDir(id), { recursive: true })
  fs.writeFileSync(path.join(chatDir(id), 'run-state.json'), JSON.stringify(runState))
  fs.writeFileSync(path.join(chatDir(id), 'chat-messages.json'), JSON.stringify(messages))
}

beforeEach(() => { config = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-cli-')); process.env.FREEBUFF_CONFIG_DIR = config })
afterEach(() => { delete process.env.FREEBUFF_CONFIG_DIR; fs.rmSync(config, { recursive: true, force: true }) })

describe('CLI chat folders', () => {
  it('lists only chats with a run state, reading the summary from messages when chat-meta.json is missing', () => {
    makeChat('2026-09-23T10-00-00.000Z', [{ variant: 'user', content: 'first prompt' }, { variant: 'ai', content: '', blocks: [] }])
    fs.mkdirSync(chatDir('empty'), { recursive: true })
    expect(listCliChats(project)).toEqual([expect.objectContaining({ chatId: '2026-09-23T10-00-00.000Z', firstPrompt: 'first prompt', messageCount: 2 })])
  })

  it('shows user prompts, reply text and tool names but not reasoning', () => {
    makeChat('c1', [
      { variant: 'user', content: 'make notes.md' },
      { variant: 'ai', content: '', blocks: [{ type: 'text', textType: 'reasoning', content: 'thinking...' }, { type: 'tool', toolName: 'write_file' }, { type: 'text', textType: 'text', content: 'Created notes.md.' }] },
    ])
    expect(readCliTranscript(project, 'c1')).toEqual([{ role: 'user', text: 'make notes.md' }, { role: 'assistant', text: '[write_file]\nCreated notes.md.' }])
  })

  it('appends a phone turn in CLI format so the transcript, run state and summary line up', () => {
    makeChat('c1', [{ variant: 'user', content: 'make notes.md' }, { variant: 'ai', content: 'done' }])
    const runState = { sessionState: { mainAgentState: { messageHistory: [1, 2, 3] } }, output: { type: 'lastMessage', value: [{ role: 'assistant', content: [{ type: 'text', text: 'Appended the line.' }] }] } }
    appendCliTurn(project, 'c1', runState, 'append a line', replyText(runState.output))
    expect(readCliRunState(project, 'c1')).toEqual(runState)
    expect(readCliTranscript(project, 'c1').slice(-2)).toEqual([{ role: 'user', text: 'append a line' }, { role: 'assistant', text: 'Appended the line.' }])
    const meta = JSON.parse(fs.readFileSync(path.join(chatDir('c1'), 'chat-meta.json'), 'utf8'))
    expect(meta).toMatchObject({ messageCount: 4, firstPrompt: 'make notes.md', messagesSize: fs.statSync(path.join(chatDir('c1'), 'chat-messages.json')).size })
  })

  it('refuses chat ids that could leave the chats folder', () => {
    for (const id of ['..', '.', '../x', 'a/b', '.hidden']) expect(() => readCliRunState(project, id)).toThrow(/Invalid chat id/)
  })
})
