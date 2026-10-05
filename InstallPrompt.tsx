import React, { useEffect, useState } from 'react'
import { installHint } from './installHint'

type InstallEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
const dismissalKey = 'pocketbuff-install-dismissed'
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
const dismissed = () => { try { return localStorage.getItem(dismissalKey) === 'yes' } catch { return false } }

export function InstallPrompt() {
  const [event, setEvent] = useState<InstallEvent | null>(null)
  const [hidden, setHidden] = useState(() => standalone() || dismissed())
  const [waited, setWaited] = useState(false)
  useEffect(() => { const t = window.setTimeout(() => setWaited(true), 8000); return () => window.clearTimeout(t) }, [])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const installed = () => { setEvent(null); setHidden(true) }
    const ready = (incoming: Event) => {
      if (standalone() || dismissed()) return
      incoming.preventDefault()
      setEvent(incoming as InstallEvent)
      setHidden(false)
    }
    const mode = window.matchMedia('(display-mode: standalone)')
    const modeChanged = () => { if (mode.matches) installed() }
    window.addEventListener('beforeinstallprompt', ready)
    window.addEventListener('appinstalled', installed)
    mode.addEventListener('change', modeChanged)
    return () => { window.removeEventListener('beforeinstallprompt', ready); window.removeEventListener('appinstalled', installed); mode.removeEventListener('change', modeChanged) }
  }, [])
  const dismiss = () => { try { localStorage.setItem(dismissalKey, 'yes') } catch { /* private storage may be unavailable */ } setHidden(true); setEvent(null) }
  const install = async () => {
    if (!event || busy) return
    setBusy(true)
    try {
      await event.prompt()
      const choice = await event.userChoice
      if (choice.outcome === 'dismissed') dismiss()
      else setHidden(true)
    } catch { /* The browser may withdraw install eligibility. Wait for a fresh event. */ }
    finally { setEvent(null); setBusy(false) }
  }
  const hint = hidden ? null : installHint({
    userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints,
    secure: window.isSecureContext, standalone: standalone(), hasInstallEvent: Boolean(event), waited,
  })
  if (!hint) return null
  return <aside className="install-prompt" aria-label="Install Pocketbuff">
    <img src="/icon-48.png" width="40" height="40" alt=""/>
    <div className="install-copy"><strong>Keep Pocketbuff close</strong><p>{hint.text}</p></div>
    {event && hint.kind === 'install' && <button className="install-action" disabled={busy} onClick={() => void install()}>{busy ? 'Opening...' : 'Install Pocketbuff'}</button>}
    <button className="install-dismiss" onClick={dismiss} aria-label="Dismiss install prompt">×</button>
  </aside>
}
