import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource/instrument-serif/400.css'
import '@fontsource/instrument-serif/400-italic.css'
import type { ServerMessage, SessionSummary } from './protocol'
import type { CliChatSummary } from './cliChats'
import './style.css'

type CardKind = 'tool' | 'diff' | 'approval'
type Item = { key: string; sessionId: string; kind: 'user' | 'assistant' | 'system' | 'card'; text: string; card?: CardKind; title?: string; subtitle?: string; status?: string; requestId?: string; detail?: string }
function chunkText(chunk: unknown) { if (typeof chunk === 'string') return chunk; if (chunk && typeof chunk === 'object' && 'text' in chunk && typeof (chunk as { text: unknown }).text === 'string') return (chunk as { text: string }).text; return '' }

/** One-line description of what a tool call touches, for the collapsed card. */
function toolSubject(input: Record<string, unknown> = {}) {
  const pick = (v: unknown) => Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : ''
  return pick(input.path) || pick(input.filePaths) || pick(input.paths) || pick(input.command) || pick(input.pattern) || pick(input.query) || pick(input.url) || ''
}

// Icons are drawn edge to edge in their viewBox so a glyph's outer edge can sit exactly on the 16px gutter.
const Icon = ({ d, w = 16, h = 16 }: { d: string; w?: number; h?: number }) => <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d}/></svg>
const icons = { terminal: 'M1 3.5 5.5 8 1 12.5M8.5 12.5H15', plus: 'M8 1v14M1 8h14', send: 'M8 14.5V1.5M2.5 7 8 1.5 13.5 7', close: 'M1 1l14 14M15 1 1 15', chevron: 'M1.25 3 7.25 8l-6 5', down: 'M8 1.5v13M2.5 9 8 14.5 13.5 9', check: 'M1.5 8.5 6 13 14.5 3' }

// Muted syntax colouring for code blocks: comments, strings, numbers and keywords only.
const KEYWORDS = /^(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|import|from|export|default|class|extends|new|async|await|try|catch|throw|type|interface|def|lambda|with|as|in|of|pass|yield|fn|pub|use|impl|struct|enum|match|true|false|null|undefined|None|True|False|self|this)$/
const HASH_COMMENTS = /^(?:py|python|sh|bash|shell|zsh|yaml|yml|toml|rb|ruby|dockerfile|make|r)$/i
function highlight(code: string, lang: string): React.ReactNode[] {
  const comment = HASH_COMMENTS.test(lang) ? String.raw`#.*$` : String.raw`\/\/.*$|\/\*[\s\S]*?\*\/`
  const re = new RegExp(`(${comment})|("(?:\\\\.|[^"\\\\\n])*"|'(?:\\\\.|[^'\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|\\b(\\d+(?:\\.\\d+)?)\\b|\\b([A-Za-z_]\\w*)\\b`, 'gm')
  const out: React.ReactNode[] = []; let last = 0, m: RegExpExecArray | null, k = 0
  while ((m = re.exec(code))) {
    if (m[4] && !KEYWORDS.test(m[4])) continue
    if (m.index > last) out.push(code.slice(last, m.index))
    const cls = m[1] ? 'tok-comment' : m[2] ? 'tok-string' : m[3] ? 'tok-number' : 'tok-keyword'
    out.push(<span key={k++} className={cls}>{m[0]}</span>); last = m.index + m[0].length
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}

/** Minimal Markdown for replies: fenced code, bullet/numbered lists, `code` and **bold**. Builds React nodes, never HTML. */
function inline(text: string, key: string): React.ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).filter(Boolean).map((part, i) =>
    part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={`${key}-${i}`}>{part.slice(1, -1)}</code>
    : part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={`${key}-${i}`}>{part.slice(2, -2)}</strong>
    : part)
}
function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (line.startsWith('```')) { const lang = line.slice(3).trim(), body: string[] = []; i++; while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]); i++; blocks.push(<pre key={i} className="codeblock">{lang && <span className="lang">{lang}</span>}<code>{highlight(body.join('\n'), lang)}</code></pre>); continue }
    const bullet = /^\s*(?:[-*]|\d+\.)\s+/
    if (bullet.test(line)) { const ordered = /^\s*\d+\./.test(line), items: string[] = []; while (i < lines.length && bullet.test(lines[i])) items.push(lines[i++].replace(bullet, '')); const List = ordered ? 'ol' : 'ul'; blocks.push(<List key={i}>{items.map((item, j) => { const task = /^\[( |x|X)\]\s+/.exec(item); return <li key={j} className={task ? 'task' : undefined}>{task && <span className={`check ${task[1] === ' ' ? '' : 'done'}`} aria-label={task[1] === ' ' ? 'to do' : 'done'}/>}{inline(task ? item.slice(task[0].length) : item, `${i}-${j}`)}</li> })}</List>); continue }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) { blocks.push(<p key={i} className="heading">{inline(heading[1], String(i))}</p>); i++; continue }
    if (!line.trim()) { i++; continue }
    const para: string[] = []; while (i < lines.length && lines[i].trim() && !lines[i].startsWith('```') && !bullet.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])) para.push(lines[i++])
    blocks.push(<p key={i}>{inline(para.join('\n'), String(i))}</p>)
  }
  return <>{blocks}</>
}

/** Readable text from a tool result: command output or a status message, else the raw JSON. */
function toolOutput(output: unknown): string {
  const parts = Array.isArray(output) ? output : [output]
  const texts: string[] = []
  for (const part of parts) {
    const value = (part as { value?: unknown; text?: unknown })?.value ?? part
    if (typeof (part as { text?: unknown })?.text === 'string') texts.push((part as { text: string }).text)
    else if (value && typeof value === 'object') { const v = value as Record<string, unknown>; const text = [v.stdout, v.stderr, v.message, v.error].filter(x => typeof x === 'string' && x.trim()).join('\n'); if (text) texts.push(text) }
    else if (typeof value === 'string') texts.push(value)
  }
  return texts.join('\n').trim() || JSON.stringify(output, null, 2)
}

/** Unified diff as rows: file headers dropped, hunks kept, +/- lines tinted. */
function DiffView({ patch }: { patch: string }) {
  const rows = patch.replace(/\n$/, '').split('\n').filter(line => !/^(={3,}|Index: |--- |\+\+\+ |diff --git)/.test(line))
  return <div className="diff" role="table">{rows.map((line, i) => {
    const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx'
    return <div key={i} className={`row ${kind}`} role="row"><span className="sign">{kind === 'add' ? '+' : kind === 'del' ? '−' : ''}</span><code>{kind === 'hunk' ? line : line.slice(1) || ' '}</code></div>
  })}</div>
}
function diffStats(patch: string) { let add = 0, del = 0; for (const line of patch.split('\n')) { if (/^\+(?!\+\+ )/.test(line)) add++; else if (/^-(?!-- )/.test(line)) del++ } return { add, del } }
const patchPath = (patch: string) => /^(?:\+\+\+ b\/|Index: )(.+)$/m.exec(patch)?.[1]?.trim() || 'Changes'
const looksLikePatch = (text: string) => /^@@ /m.test(text)

/** Shown until the phone has a token: enter the 6-digit code from `install.sh pair`, or arrive with it in the link (#pair=123456). */
function Pair({ onToken }: { onToken: (token: string) => void }) {
  const [code, setCode] = useState(() => (new URLSearchParams(location.hash.slice(1)).get('pair') || '').replace(/\D/g, '').slice(0, 6))
  const [state, setState] = useState<'idle' | 'busy' | 'wrong'>('idle')
  const submit = async (value = code) => {
    if (value.length !== 6 || state === 'busy') return
    setState('busy')
    try {
      const res = await fetch('/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: value }) })
      const data = await res.json() as { token?: string }
      if (res.ok && data.token) { history.replaceState(null, '', location.pathname + location.search); onToken(data.token); return }
    } catch { /* network failure reads the same as a wrong code: try again */ }
    setState('wrong')
  }
  useEffect(() => { if (code.length === 6) void submit(code) }, [])
  return <main className="pair">
    <header className="top"><div className="brand"><h1>Pocketbuff</h1></div></header>
    <form className="pair-body" onSubmit={e => { e.preventDefault(); void submit() }}>
      <h2>Pair this <em>phone</em></h2>
      <p>Enter the 6-digit code from your computer.</p>
      <input className="code" value={code} onChange={e => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setState('idle') }} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" aria-label="Pairing code" autoFocus/>
      <button className="primary" disabled={code.length !== 6 || state === 'busy'}>{state === 'busy' ? 'Pairing' : 'Pair'}</button>
      <p className={`hint ${state === 'wrong' ? 'error' : ''}`}>{state === 'wrong' ? 'That code is wrong or expired. Ask your computer for a new one.' : <>No code? Run <code>bash ~/.pocketbuff/install.sh pair</code></>}</p>
    </form>
  </main>
}

function Root() {
  const [token, setToken] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') || localStorage.getItem('freebuff-token') || '')
  return token ? <App token={token}/> : <Pair onToken={setToken}/>
}

function App({ token }: { token: string }) {
  const [status, setStatus] = useState('connecting'), [sessions, setSessions] = useState<SessionSummary[]>([]), [active, setActive] = useState('')
  const [items, setItems] = useState<Item[]>([]), [busy, setBusy] = useState<Record<string, boolean>>({}), [text, setText] = useState('')
  const [cliList, setCliList] = useState<{ sessionId: string; chats: CliChatSummary[] } | null>(null), [attached, setAttached] = useState<Record<string, string | null>>({})
  const socket = useRef<WebSocket | null>(null), feed = useRef<HTMLElement | null>(null), activeRef = useRef(''), input = useRef<HTMLTextAreaElement | null>(null)
  const send = (value: unknown): boolean => { if (socket.current?.readyState !== WebSocket.OPEN) return false; socket.current.send(JSON.stringify(value)); return true }

  useEffect(() => {
    if (token) { localStorage.setItem('freebuff-token', token); if (location.hash) history.replaceState(null, '', location.pathname + location.search) }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
    let closed = false, retry = 0, timer: ReturnType<typeof setTimeout> | undefined, seq = 0
    const add = (item: Omit<Item, 'key'>) => setItems(v => [...v, { ...item, key: `i${seq++}` }])
    // Replace a card in place so its position in the timeline stays where it first appeared.
    const upsertCard = (key: string, item: Omit<Item, 'key' | 'kind'>) => setItems(v => v.some(i => i.key === key) ? v.map(i => i.key === key ? { ...i, ...item } : i) : [...v, { ...item, key, kind: 'card' }])
    const connect = () => {
      setStatus(retry ? 'reconnecting' : 'connecting')
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?token=${encodeURIComponent(token)}`); socket.current = ws
      ws.onopen = () => { retry = 0; setStatus('connected') }
      ws.onerror = () => setStatus('error')
      ws.onclose = () => { if (closed) return; setStatus('disconnected'); retry++; timer = setTimeout(connect, Math.min(10000, 500 * 2 ** retry)) }
      ws.onmessage = (e) => {
        const message = JSON.parse(e.data) as ServerMessage
        // The server replays each session's transcript after ready, so start from a clean slate.
        if (message.type === 'ready') { setItems([]); setBusy({}); setAttached({}); setCliList(null) }
        if (message.type === 'ready' || message.type === 'sessions') { setSessions(message.sessions); setActive(message.activeSessionId); activeRef.current = message.activeSessionId }
        if (message.type === 'user') add({ sessionId: message.sessionId, kind: 'user', text: message.text })
        if (message.type === 'run-start') { setBusy(v => ({ ...v, [message.sessionId]: true })); add({ sessionId: message.sessionId, kind: 'assistant', text: '' }) }
        if (message.type === 'chunk') { const value = chunkText(message.chunk); if (value) setItems(v => { const next = [...v]; let i = next.length - 1; while (i >= 0 && !(next[i].sessionId === message.sessionId && next[i].kind === 'assistant')) i--; if (i >= 0) next[i] = { ...next[i], text: next[i].text + value }; return next }) }
        if (message.type === 'tool') upsertCard(`tool-${message.sessionId}-${message.tool.id}`, { sessionId: message.sessionId, card: 'tool', title: message.tool.name, subtitle: toolSubject(message.tool.input), text: JSON.stringify(message.tool.input, null, 2), detail: message.tool.output === undefined ? undefined : toolOutput(message.tool.output), status: message.tool.status })
        if (message.type === 'diff') upsertCard(`diff-${message.sessionId}-${message.toolCallId}`, { sessionId: message.sessionId, card: 'diff', title: patchPath(message.patch), text: message.patch, status: 'ready' })
        if (message.type === 'approval-request') upsertCard(`approval-${message.requestId}`, { sessionId: message.sessionId, card: 'approval', requestId: message.requestId, title: message.toolName, subtitle: toolSubject(message.input), detail: message.reason, text: typeof message.input.content === 'string' ? message.input.content : typeof message.input.command === 'string' ? `$ ${message.input.command}` : JSON.stringify(message.input, null, 2), status: 'waiting' })
        if (message.type === 'approval-resolved') setItems(v => v.map(i => i.requestId === message.requestId ? { ...i, status: message.decision } : i))
        if (message.type === 'run-finish' || message.type === 'run-cancelled') setBusy(v => ({ ...v, [message.sessionId]: false }))
        if (message.type === 'run-cancelled') add({ sessionId: message.sessionId, kind: 'system', text: 'Run cancelled' })
        if (message.type === 'cli-chats') setCliList({ sessionId: message.sessionId, chats: message.chats })
        if (message.type === 'cli-attached') setAttached(v => ({ ...v, [message.sessionId]: message.chatId }))
        if (message.type === 'cli-opened') {
          setAttached(v => ({ ...v, [message.sessionId]: message.chatId })); setCliList(null)
          add({ sessionId: message.sessionId, kind: 'system', text: message.chatId ? 'Continuing terminal chat' : 'Back to the phone session' })
          for (const entry of message.transcript) add(entry.role === 'tool' ? { sessionId: message.sessionId, kind: 'card', card: 'tool', title: entry.text, subtitle: entry.subject, text: '', detail: entry.output || undefined, status: 'succeeded' } : { sessionId: message.sessionId, kind: entry.role, text: entry.text })
        }
        if (message.type === 'error') add({ sessionId: message.sessionId ?? activeRef.current, kind: 'system', text: `Error: ${message.message}` })
      }
    }
    connect()
    return () => { closed = true; clearTimeout(timer); socket.current?.close() }
  }, [token])
  // Follow new output only while the reader is at the bottom; otherwise offer a jump-to-latest pill.
  const [pinned, setPinned] = useState(true), [unseen, setUnseen] = useState(false)
  const lastTop = useRef(0)
  const toLatest = (behavior: ScrollBehavior = 'smooth') => { setPinned(true); setUnseen(false); feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior }) }
  // Only an upward scroll by the reader unpins; programmatic smooth scrolls move down and never do.
  const onScroll = () => {
    const el = feed.current; if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    if (atBottom) { setPinned(true); setUnseen(false) } else if (el.scrollTop < lastTop.current - 4) setPinned(false)
    lastTop.current = el.scrollTop
  }
  // Only output in the open session counts as unseen; other sessions streaming in the background do not.
  const feedSignature = items.filter(item => item.sessionId === active).map(item => `${item.key}:${item.text.length}:${item.status ?? ''}`).join('|')
  useEffect(() => { if (pinned) toLatest(); else setUnseen(true) }, [feedSignature])
  useEffect(() => { setPinned(true); toLatest('auto') }, [active])
  // Grow the composer with its content, up to the CSS max-height.
  useEffect(() => { const el = input.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }, [text])

  const visible = items.filter(item => item.sessionId === active), running = !!busy[active], lastAssistant = visible.filter(item => item.kind === 'assistant').at(-1)?.key
  const current = sessions.find(session => session.id === active)
  const submit = (event: React.FormEvent) => { event.preventDefault(); const value = text.trim(); if (!value || running || !active) return; send({ type: 'chat', sessionId: active, text: value }); setText('') }
  const create = () => { const projectDir = prompt('Absolute project path'); if (!projectDir) return; const name = prompt('Session name', projectDir.split('/').pop() || 'Project') || 'Project'; send({ type: 'session-create', name, projectDir }) }
  const [pressed, setPressed] = useState<Record<string, 'approve' | 'deny'>>({})
  // Lock the buttons only once the decision actually left the socket; a reconnect clears locks so a lost decision can be retried.
  const decide = (item: Item, decision: 'approve' | 'deny') => { const id = item.requestId; if (!id || pressed[id]) return; if (send({ type: 'approval', sessionId: item.sessionId, requestId: id, decision })) setPressed(v => ({ ...v, [id]: decision })) }
  useEffect(() => { if (status === 'connected') setPressed({}) }, [status])

  const renderCard = (item: Item) => {
    if (item.card === 'diff') { const { add, del } = diffStats(item.text); return <article key={item.key} className="card diff-card"><header><code className="path">{item.title}</code><span className="stats"><span className="plus">+{add}</span><span className="minus">−{del}</span></span></header><DiffView patch={item.text}/></article> }
    if (item.card === 'approval') {
      const waiting = item.status === 'waiting', press = item.requestId ? pressed[item.requestId] : undefined
      return <article key={item.key} className={`card approval ${item.status ?? ''} ${press ? `pressed-${press}` : ''}`}>
        <header><span className="label">{!waiting && item.status === 'approve' && <Icon d={icons.check}/>}{waiting ? 'Needs approval' : item.status === 'approve' ? 'Approved' : 'Denied'}</span><code className="tool">{item.title}</code></header>
        {item.subtitle && !item.text.startsWith('$ ') && <code className="path">{item.subtitle}</code>}
        {item.detail && !/can change the project/.test(item.detail) && <p className="reason">{item.detail}</p>}
        {looksLikePatch(item.text) ? <DiffView patch={item.text}/> : <pre>{item.text}</pre>}
        {item.requestId && (waiting || press) && <div className={`actions-wrap ${waiting ? '' : 'gone'}`}><div><div className="actions"><button className="ghost" disabled={!!press} onClick={() => decide(item, 'deny')}>Deny</button><button className="primary" disabled={!!press} onClick={() => decide(item, 'approve')}>Approve</button></div></div></div>}
      </article>
    }
    return <details key={item.key} className={`card tool ${item.status}`}><summary><span className="dot"/><code className="tool">{item.title}</code><span className="subject">{item.subtitle}</span><span className="chev"><Icon d={icons.chevron} w={8}/></span></summary>{(item.detail ?? item.text) && <pre>{item.detail ?? item.text}</pre>}</details>
  }

  return <main>
    <header className="top">
      <div className="brand"><h1>Pocketbuff</h1><span className={`status ${status}`} title={status}><i/>{status}</span></div>
      <div className="tools">
        <button className="icon" aria-label="Terminal chats" title="Terminal chats" onClick={() => send({ type: 'cli-list', sessionId: active })}><Icon d={icons.terminal}/></button>
        <button className="icon" aria-label="New session" title="New session" onClick={create}><Icon d={icons.plus}/></button>
      </div>
    </header>
    <nav className="rail">{sessions.map(session => <button key={session.id} className={session.id === active ? 'active' : ''} onClick={() => send({ type: 'session-select', sessionId: session.id })}>{busy[session.id] && <i className="live" aria-label="running"/>}{session.name}</button>)}</nav>
    {attached[active] && <div className="attached"><span><Icon d={icons.terminal}/>Terminal chat <code>{attached[active]}</code></span><button className="link" onClick={() => send({ type: 'cli-open', sessionId: active, chatId: null })}>Detach</button></div>}
    <section ref={feed} className="feed" key={active} onScroll={onScroll}>
      {visible.length === 0 && <div className="empty"><h2>What should we <em>build</em>?</h2><p><code>{current?.projectDir}</code></p><button className="quiet" onClick={() => send({ type: 'cli-list', sessionId: active })}>Continue a terminal chat<Icon d={icons.chevron} w={8}/></button></div>}
      {visible.map(item => item.kind === 'card' ? renderCard(item)
        : item.kind === 'system' ? <p key={item.key} className={item.text.startsWith('Error') ? 'system error' : 'system'}>{item.text}</p>
        : <article key={item.key} className={item.kind}>{item.kind === 'assistant' ? <Markdown text={item.text}/> : item.text}{running && item.key === lastAssistant && <span className="caret" aria-hidden="true"/>}</article>)}
    </section>
    <div className="latest-anchor">{!pinned && unseen && <button className="latest" onClick={() => toLatest()}>Latest<Icon d={icons.down}/></button>}</div>
    <form className="composer" onSubmit={submit}>
      <textarea ref={input} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }} placeholder={attached[active] ? 'Continue the terminal chat' : 'Ask Freebuff'} rows={1}/>
      {running
        ? <button type="button" className="send stop" aria-label="Cancel run" title="Cancel run" onClick={() => send({ type: 'cancel', sessionId: active })}><i/></button>
        : <button className="send" aria-label="Send" title="Send" disabled={!text.trim() || status !== 'connected'}><Icon d={icons.send}/></button>}
    </form>
    {cliList?.sessionId === active && <div className="sheet-backdrop" onClick={() => setCliList(null)}>
      <div className="sheet" role="dialog" aria-label="Terminal chats" onClick={e => e.stopPropagation()}>
        <header><h2>Terminal chats</h2><button className="icon" aria-label="Close" onClick={() => setCliList(null)}><Icon d={icons.close}/></button></header>
        <p className="hint">Chats started with <code>freebuff</code> in <code>{current?.projectDir}</code></p>
        {cliList.chats.length ? <ul>{cliList.chats.map(chat => <li key={chat.chatId}><button onClick={() => send({ type: 'cli-open', sessionId: active, chatId: chat.chatId })}><span className="title">{chat.firstPrompt || chat.chatId}</span><span className="meta">{chat.messageCount} messages · {new Date(chat.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></button></li>)}</ul>
          : <div className="empty small"><p>No terminal chats in this project yet. Run <code>freebuff</code> here and it will show up.</p></div>}
      </div>
    </div>}
  </main>
}
createRoot(document.getElementById('root')!).render(<Root />)
