import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ServerMessage } from './protocol'
import './style.css'

type Line = { role: 'user' | 'assistant' | 'system'; text: string }
type Card = { id: string; title: string; detail: string; status: string; requestId?: string }

function chunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (chunk && typeof chunk === 'object' && 'text' in chunk && typeof (chunk as { text: unknown }).text === 'string') return (chunk as { text: string }).text
  return ''
}

function App() {
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') || localStorage.getItem('freebuff-token') || '')
  const [status, setStatus] = useState('connecting')
  const [lines, setLines] = useState<Line[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [cards, setCards] = useState<Card[]>([])
  const socket = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (token) {
      localStorage.setItem('freebuff-token', token)
      if (location.hash) history.replaceState(null, '', location.pathname + location.search)
    }
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`)
    socket.current = ws
    ws.onopen = () => setStatus('connected')
    ws.onclose = () => setStatus('disconnected')
    ws.onerror = () => setStatus('error')
    ws.onmessage = (e) => {
      const message = JSON.parse(e.data) as ServerMessage
      if (message.type === 'ready') setLines((v) => [...v, { role: 'system', text: `${message.runtime} runtime · ${message.projectDir}` }])
      if (message.type === 'run-start') { setBusy(true); setLines((v) => [...v, { role: 'assistant', text: '' }]) }
      if (message.type === 'chunk') {
        const value = chunkText(message.chunk)
        if (value) setLines((v) => { const next = [...v]; const i = next.length - 1; if (i >= 0 && next[i].role === 'assistant') next[i] = { ...next[i], text: next[i].text + value }; return next })
      }
      if (message.type === 'tool') setCards((v) => [...v.filter((card) => card.id !== message.tool.id), { id: message.tool.id, title: message.tool.name, detail: JSON.stringify(message.tool.input, null, 2), status: message.tool.status }])
      if (message.type === 'diff') setCards((v) => [...v, { id: `diff-${message.toolCallId}`, title: 'Diff', detail: message.patch, status: 'ready' }])
      if (message.type === 'approval-request') setCards((v) => [...v, { id: message.toolCallId, requestId: message.requestId, title: `Approval: ${message.toolName}`, detail: message.reason + '\n' + JSON.stringify(message.input, null, 2), status: 'waiting' }])
      if (message.type === 'approval-resolved') setCards((v) => v.map((card) => card.requestId === message.requestId ? { ...card, status: message.decision } : card))
      if (message.type === 'run-finish' || message.type === 'run-cancelled') setBusy(false)
      if (message.type === 'error') { setBusy(false); setLines((v) => [...v, { role: 'system', text: `Error: ${message.message}` }]) }
    }
    return () => ws.close()
  }, [token])

  const decide = (requestId: string, decision: 'approve' | 'deny') => socket.current?.send(JSON.stringify({ type: 'approval', requestId, decision }))
  const cancel = () => socket.current?.send(JSON.stringify({ type: 'cancel' }))

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const value = text.trim()
    if (!value || busy || socket.current?.readyState !== WebSocket.OPEN) return
    setLines((v) => [...v, { role: 'user', text: value }])
    socket.current.send(JSON.stringify({ type: 'chat', text: value }))
    setText('')
  }

  return <main>
    <header><h1>Freebuff Remote</h1><span className={status}>{status}</span></header>
    <section>{lines.map((line, i) => <article key={i} className={line.role}>{line.text || (busy ? 'Thinking…' : '')}</article>)}{cards.map((card) => <article key={card.id} className="card"><strong>{card.title}</strong><small>{card.status}</small><pre>{card.detail}</pre>{card.requestId && card.status === 'waiting' && <div><button onClick={() => decide(card.requestId!, 'approve')}>Approve</button><button className="deny" onClick={() => decide(card.requestId!, 'deny')}>Deny</button></div>}</article>)}</section>
    {busy && <button className="cancel" onClick={cancel}>Cancel run</button>}
    <form onSubmit={submit}><textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Freebuff…" rows={3}/><button disabled={busy || status !== 'connected'}>{busy ? 'Running' : 'Send'}</button></form>
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)
