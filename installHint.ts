export type InstallHintInput = {
  userAgent: string
  platform: string
  maxTouchPoints: number
  secure: boolean
  standalone: boolean
  hasInstallEvent: boolean
  waited: boolean // true once the browser has had a few seconds to offer install
}
export type InstallHint =
  | { kind: 'install'; text: string }
  | { kind: 'ios-safari' | 'ios-other' | 'needs-https' | 'chrome-menu'; text: string }
  | null

const isIos = (i: InstallHintInput) => /iPhone|iPad|iPod/.test(i.userAgent) || (i.platform === 'MacIntel' && i.maxTouchPoints > 1)
const isIosSafari = (i: InstallHintInput) => isIos(i) && /Safari/.test(i.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/.test(i.userAgent)
const isAndroid = (i: InstallHintInput) => /Android/.test(i.userAgent)

// What the install banner should say for this device. null = show nothing.
export function installHint(i: InstallHintInput): InstallHint {
  if (i.standalone) return null
  const phone = isIos(i) || isAndroid(i)
  if (!i.secure) {
    // Browsers only install a PWA over HTTPS. Local http links work in the browser but never offer install.
    return phone ? { kind: 'needs-https', text: 'Installing needs the HTTPS link. Set Pocketbuff up with Tailscale to get one.' } : null
  }
  if (isIos(i)) {
    return isIosSafari(i)
      ? { kind: 'ios-safari', text: 'Tap Share, then Add to Home Screen.' }
      : { kind: 'ios-other', text: 'Open this link in Safari, then tap Share and Add to Home Screen.' }
  }
  if (i.hasInstallEvent) return { kind: 'install', text: 'Open it from your home screen.' }
  if (isAndroid(i) && i.waited) return { kind: 'chrome-menu', text: 'In Chrome, open the menu and tap Install app.' }
  return null
}
