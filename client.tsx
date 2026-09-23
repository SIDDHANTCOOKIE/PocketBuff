import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ServerMessage, SessionSummary } from './protocol'
import './style.css'

type Item = { key: string; sessionId: string; kind: 'user' | 'assistant' | 'system' | 'card'; text: string; title?: string; status?: string; requestId?: string }
function chunkText(chunk: unknown) { if (typeof chunk === 'string') return chunk; if (chunk && typeof chunk === 'object' && 'text' in chunk && typeof (chunk as { text: unknown }).text === 'string') return (chunk as { text: string }).text; return '' }

function App() {
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') || localStorage.getItem('freebuff-token') || '')
  const [status, setStatus] = useState('connecting'), [sessions, setSessions] = useState<SessionSummary[]>([]), [active, setActive] = useState('')
  const [items, setItems] = useState<Item[]>([]), [busy, setBusy] = useState<Record<string, boolean>>({}), [text, setText] = useState('')
  const socket = useRef<WebSocket | null>(null), feed = useRef<HTMLElement | null>(null), activeRef = useRef('')
  const send = (value: unknown) => socket.current?.readyState === WebSocket.OPEN && socket.current.send(JSON.stringify(value))

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
        if (message.type === 'ready') { setItems([]); setBusy({}) }
        if (message.type === 'ready' || message.type === 'sessions') { setSessions(message.sessions); setActive(message.activeSessionId); activeRef.current = message.activeSessionId }
        if (message.type === 'user') add({ sessionId: message.sessionId, kind: 'user', text: message.text })
        if (message.type === 'run-start') { setBusy(v => ({ ...v, [message.sessionId]: true })); add({ sessionId: message.sessionId, kind: 'assistant', text: '' }) }
        if (message.type === 'chunk') { const value = chunkText(message.chunk); if (value) setItems(v => { const next = [...v]; let i = next.length - 1; while (i >= 0 && !(next[i].sessionId === message.sessionId && next[i].kind === 'assistant')) i--; if (i >= 0) next[i] = { ...next[i], text: next[i].text + value }; return next }) }
        if (message.type === 'tool') upsertCard(`tool-${message.sessionId}-${message.tool.id}`, { sessionId: message.sessionId, title: message.tool.name, text: JSON.stringify(message.tool.output ?? message.tool.input, null, 2), status: message.tool.status })
        if (message.type === 'diff') upsertCard(`diff-${message.sessionId}-${message.toolCallId}`, { sessionId: message.sessionId, title: 'Diff', text: message.patch, status: 'ready' })
        if (message.type === 'approval-request') upsertCard(`approval-${message.requestId}`, { sessionId: message.sessionId, requestId: message.requestId, title: `Approval: ${message.toolName}`, text: message.reason + '\n' + (typeof message.input.content === 'string' ? `${message.input.path ?? ''}\n${message.input.content}` : JSON.stringify(message.input, null, 2)), status: 'waiting' })
        if (message.type === 'approval-resolved') setItems(v => v.map(i => i.requestId === message.requestId ? { ...i, status: message.decision } : i))
        if (message.type === 'run-finish' || message.type === 'run-cancelled') setBusy(v => ({ ...v, [message.sessionId]: false }))
        if (message.type === 'error') add({ sessionId: message.sessionId ?? activeRef.current, kind: 'system', text: `Error: ${message.message}` })
      }
    }
    connect()
    return () => { closed = true; clearTimeout(timer); socket.current?.close() }
  }, [token])
  useEffect(() => { feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: 'smooth' }) }, [items, active])

  const visible = items.filter(item => item.sessionId === active), running = !!busy[active]
  const submit = (event: React.FormEvent) => { event.preventDefault(); const value = text.trim(); if (!value || running || !active) return; send({ type: 'chat', sessionId: active, text: value }); setText('') }
  const create = () => { const projectDir = prompt('Absolute project path'); if (!projectDir) return; const name = prompt('Session name', projectDir.split('/').pop() || 'Project') || 'Project'; send({ type: 'session-create', name, projectDir }) }

  return <main>
    <header><div><h1>Freebuff Remote</h1><span className={status}>{status}</span></div><button className="new" onClick={create}>+ Session</button></header>
    <nav>{sessions.map(session => <button key={session.id} className={session.id === active ? 'active' : ''} onClick={() => send({ type: 'session-select', sessionId: session.id })}>{session.name}<small>{session.projectDir}</small></button>)}</nav>
    <section ref={feed}>{visible.map(item => item.kind === 'card' ? <article key={item.key} className="card"><strong>{item.title}</strong><small>{item.status}</small><pre>{item.text}</pre>{item.requestId && item.status === 'waiting' && <div><button onClick={() => send({ type: 'approval', sessionId: item.sessionId, requestId: item.requestId, decision: 'approve' })}>Approve</button><button className="deny" onClick={() => send({ type: 'approval', sessionId: item.sessionId, requestId: item.requestId, decision: 'deny' })}>Deny</button></div>}</article> : <article key={item.key} className={item.kind}>{item.text || (running ? 'Thinking…' : '')}</article>)}</section>
    {running && <button className="cancel" onClick={() => send({ type: 'cancel', sessionId: active })}>Cancel run</button>}
    <form onSubmit={submit}><textarea value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }} placeholder="Ask Freebuff…" rows={3}/><button disabled={running || status !== 'connected'}>{running ? 'Running' : 'Send'}</button></form>
  </main>
}
createRoot(document.getElementById('root')!).render(<App />)
