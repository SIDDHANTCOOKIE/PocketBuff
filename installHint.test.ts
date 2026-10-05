import { describe, expect, it } from 'vitest'
import { installHint, type InstallHintInput } from './installHint'

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1'
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const base = (over: Partial<InstallHintInput>): InstallHintInput => ({
  userAgent: ANDROID, platform: 'Linux armv81', maxTouchPoints: 5, secure: true, standalone: false, hasInstallEvent: false, waited: false, ...over,
})

describe('installHint', () => {
  it('shows nothing once installed', () => expect(installHint(base({ standalone: true, hasInstallEvent: true }))).toBeNull())
  it('Android on http says install needs the HTTPS link', () => {
    const h = installHint(base({ secure: false }))
    expect(h?.kind).toBe('needs-https')
    expect(h?.text).toContain('Tailscale')
  })
  it('Android on http never offers the install button, even with an event', () => expect(installHint(base({ secure: false, hasInstallEvent: true }))?.kind).toBe('needs-https'))
  it('Android on https with the install event offers the button', () => expect(installHint(base({ hasInstallEvent: true }))?.kind).toBe('install'))
  it('Android on https shows nothing until the browser had time, then the menu hint', () => {
    expect(installHint(base({}))).toBeNull()
    expect(installHint(base({ waited: true }))?.kind).toBe('chrome-menu')
  })
  it('iPhone Safari gets Share > Add to Home Screen', () => expect(installHint(base({ userAgent: IOS_SAFARI, platform: 'iPhone' }))?.kind).toBe('ios-safari'))
  it('iPhone Chrome is told to use Safari', () => {
    const h = installHint(base({ userAgent: IOS_CHROME, platform: 'iPhone' }))
    expect(h?.kind).toBe('ios-other')
    expect(h?.text).toContain('Safari')
  })
  it('iPhone on http says it needs HTTPS', () => expect(installHint(base({ userAgent: IOS_SAFARI, platform: 'iPhone', secure: false }))?.kind).toBe('needs-https'))
  it('desktop: nothing on http, button only when the browser offers it', () => {
    const d = { userAgent: DESKTOP, platform: 'Win32', maxTouchPoints: 0 }
    expect(installHint(base({ ...d, secure: false }))).toBeNull()
    expect(installHint(base({ ...d, waited: true }))).toBeNull()
    expect(installHint(base({ ...d, hasInstallEvent: true }))?.kind).toBe('install')
  })
})
