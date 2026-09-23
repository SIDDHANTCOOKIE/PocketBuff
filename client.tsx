import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ServerMessage, SessionSummary } from './protocol'
import './style.css'

type Line = { sessionId: string; role: 'user' | 'assistant' | 'system'; text: string }
type Card = { id: string; sessionId: string; title: string; detail: string; status: string; requestId?: string }
function chunkText(chunk: unknown) { if (typeof chunk === 'string') return chunk; if (chunk && typeof chunk === 'object' && 'text' in chunk && typeof (chunk as { text: unknown }).text === 'string') return (chunk as { text: string }).text; return '' }

function App() {
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') || localStorage.getItem('freebuff-token') || '')
  const [status, setStatus] = useState('connecting'), [sessions, setSessions] = useState<SessionSummary[]>([]), [active, setActive] = useState('')
  const [lines, setLines] = useState<Line[]>([]), [cards, setCards] = useState<Card[]>([]), [busy, setBusy] = useState<Record<string, boolean>>({}), [text, setText] = useState('')
  const socket = useRef<WebSocket | null>(null), feed = useRef<HTMLElement | null>(null), activeRef = useRef('')
  const send = (value: unknown) => socket.current?.readyState === WebSocket.OPEN && socket.current.send(JSON.stringify(value))

  useEffect(() => {
    if (token) { localStorage.setItem('freebuff-token', token); if (location.hash) history.replaceState(null, '', location.pathname + location.search) }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?token=${encodeURIComponent(token)}`); socket.current = ws
    ws.onopen = () => setStatus('connected'); ws.onclose = () => setStatus('disconnected'); ws.onerror = () => setStatus('error')
    ws.onmessage = (e) => {
      const message = JSON.parse(e.data) as ServerMessage
      if (message.type === 'ready' || message.type === 'sessions') { setSessions(message.sessions); setActive(message.activeSessionId); activeRef.current = message.activeSessionId }
      if (message.type === 'run-start') { setBusy(v => ({ ...v, [message.sessionId]: true })); setLines(v => [...v, { sessionId: message.sessionId, role: 'assistant', text: '' }]) }
      if (message.type === 'chunk') { const value = chunkText(message.chunk); if (value) setLines(v => { const next = [...v]; let i = next.length - 1; while (i >= 0 && !(next[i].sessionId === message.sessionId && next[i].role === 'assistant')) i--; if (i >= 0) next[i] = { ...next[i], text: next[i].text + value }; return next }) }
      if (message.type === 'tool') setCards(v => [...v.filter(card => card.id !== message.tool.id || card.sessionId !== message.sessionId), { id: message.tool.id, sessionId: message.sessionId, title: message.tool.name, detail: JSON.stringify(message.tool.output ?? message.tool.input, null, 2), status: message.tool.status }])
      if (message.type === 'diff') setCards(v => [...v, { id: `diff-${message.toolCallId}`, sessionId: message.sessionId, title: 'Diff', detail: message.patch, status: 'ready' }])
      if (message.type === 'approval-request') setCards(v => [...v, { id: message.toolCallId, sessionId: message.sessionId, requestId: message.requestId, title: `Approval: ${message.toolName}`, detail: message.reason + '\n' + JSON.stringify(message.input, null, 2), status: 'waiting' }])
      if (message.type === 'approval-resolved') setCards(v => v.map(card => card.requestId === message.requestId ? { ...card, status: message.decision } : card))
      if (message.type === 'run-finish' || message.type === 'run-cancelled') setBusy(v => ({ ...v, [message.sessionId]: false }))
      if (message.type === 'error') setLines(v => [...v, { sessionId: activeRef.current, role: 'system', text: `Error: ${message.message}` }])
    }; return () => ws.close()
  }, [token])
  useEffect(() => { feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: 'smooth' }) }, [lines, cards, active])

  const visibleLines = lines.filter(line => line.sessionId === active), visibleCards = cards.filter(card => card.sessionId === active), running = !!busy[active]
  const submit = (event: React.FormEvent) => { event.preventDefault(); const value = text.trim(); if (!value || running || !active) return; setLines(v => [...v, { sessionId: active, role: 'user', text: value }]); send({ type: 'chat', sessionId: active, text: value }); setText('') }
  const create = () => { const projectDir = prompt('Absolute project path'); if (!projectDir) return; const name = prompt('Session name', projectDir.split('/').pop() || 'Project') || 'Project'; send({ type: 'session-create', name, projectDir }) }

  return <main>
    <header><div><h1>Freebuff Remote</h1><span className={status}>{status}</span></div><button className="new" onClick={create}>+ Session</button></header>
    <nav>{sessions.map(session => <button key={session.id} className={session.id === active ? 'active' : ''} onClick={() => send({ type: 'session-select', sessionId: session.id })}>{session.name}<small>{session.projectDir}</small></button>)}</nav>
    <section ref={feed}>{visibleLines.map((line, i) => <article key={i} className={line.role}>{line.text || (running ? 'Thinking…' : '')}</article>)}{visibleCards.map(card => <article key={card.id} className="card"><strong>{card.title}</strong><small>{card.status}</small><pre>{card.detail}</pre>{card.requestId && card.status === 'waiting' && <div><button onClick={() => send({ type: 'approval', sessionId: active, requestId: card.requestId, decision: 'approve' })}>Approve</button><button className="deny" onClick={() => send({ type: 'approval', sessionId: active, requestId: card.requestId, decision: 'deny' })}>Deny</button></div>}</article>)}</section>
    {running && <button className="cancel" onClick={() => send({ type: 'cancel', sessionId: active })}>Cancel run</button>}
    <form onSubmit={submit}><textarea value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }} placeholder="Ask Freebuff…" rows={3}/><button disabled={running || status !== 'connected'}>{running ? 'Running' : 'Send'}</button></form>
  </main>
}
createRoot(document.getElementById('root')!).render(<App />)
