import React, { useEffect, useState } from 'react'

type InstallEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
const dismissalKey = 'pocketbuff-install-dismissed'
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
const dismissed = () => { try { return localStorage.getItem(dismissalKey) === 'yes' } catch { return false } }
const iosSafari = () => (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/.test(navigator.userAgent)

export function InstallPrompt() {
  const [event, setEvent] = useState<InstallEvent | null>(null)
  const [hidden, setHidden] = useState(() => standalone() || dismissed())
  const [ios] = useState(iosSafari)
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
  if (hidden || (!event && !ios)) return null
  return <aside className="install-prompt" aria-label="Install Pocketbuff">
    <img src="/icon-48.png" width="40" height="40" alt=""/>
    <div className="install-copy"><strong>Keep Pocketbuff close</strong><p>{ios ? 'Tap Share, then Add to Home Screen.' : 'Open it from your home screen.'}</p></div>
    {event && <button className="install-action" disabled={busy} onClick={() => void install()}>{busy ? 'Opening...' : 'Install Pocketbuff'}</button>}
    <button className="install-dismiss" onClick={dismiss} aria-label="Dismiss install prompt">×</button>
  </aside>
}
