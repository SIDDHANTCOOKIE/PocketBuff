import fs from 'node:fs'
import path from 'node:path'
import freebuffAgents from './freebuff-agents.json' with { type: 'json' }

// Freebuff free mode admits one session slot per account (POST /api/v1/freebuff/session/admission) and
// requires its instance id on every model call. This mirrors the official CLI's client
// (codebuff cli/src/utils/freebuff-session-api.ts) with only the parts the companion needs.

export const DEFAULT_FREEBUFF_MODEL = 'z-ai/glm-5.3-flash'
// Free mode checks the (root agent id, model) pair. These are the CLI's own base3 roots (freebuff-agents.json).
export const FREE_MODE_ROOT_AGENT: Record<string, string> = Object.fromEntries(Object.entries(freebuffAgents.byModel).map(([model, def]) => [model, def.id]))

export type FreebuffSlot = { instanceId: string; model: string; agentId: string; expiresAt: string }
type SessionResponse = { status?: string; instanceId?: string; model?: string; expiresAt?: string; message?: string; freebucks?: { prices?: Record<string, number> } }
type Fetch = typeof fetch

export interface SlotOptions { token: string; stateFile: string; model?: string; allowFreebucks?: boolean; baseUrl?: string; fetch?: Fetch; now?: () => number }

export class FreebuffSlotClient {
  private slot?: FreebuffSlot
  private verified = false
  private pending?: Promise<FreebuffSlot>
  private readonly model: string
  private readonly baseUrl: string
  private readonly fetch: Fetch
  private readonly now: () => number

  constructor(private options: SlotOptions) {
    this.model = options.model || DEFAULT_FREEBUFF_MODEL
    this.baseUrl = (options.baseUrl || 'https://www.codebuff.com').replace(/\/$/, '')
    this.fetch = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    try { this.slot = JSON.parse(fs.readFileSync(options.stateFile, 'utf8')) as FreebuffSlot } catch { this.slot = undefined }
  }

  /** Returns a live slot, reusing the current one while it has time left. Concurrent callers share one admission. */
  ensure(): Promise<FreebuffSlot> {
    this.pending ??= this.resolve().finally(() => { this.pending = undefined })
    return this.pending
  }

  /** Forget the slot so the next run admits again (after the server rejects the instance). */
  invalidate() { this.slot = undefined; this.verified = false; fs.rmSync(this.options.stateFile, { force: true }) }

  /** Gives the slot back so the user's own Freebuff CLI can take it. */
  async release() {
    const slot = this.slot; if (!slot) return
    this.invalidate()
    await this.call('DELETE', '/api/v1/freebuff/session', { 'x-freebuff-instance-id': slot.instanceId }).catch(() => undefined)
  }

  private async resolve(): Promise<FreebuffSlot> {
    const slot = this.slot
    if (slot && Date.parse(slot.expiresAt) - this.now() > 60_000) {
      if (this.verified) return slot
      const current = await this.call('GET', '/api/v1/freebuff/session', { 'x-freebuff-instance-id': slot.instanceId })
      if (current.status === 'active' && current.instanceId === slot.instanceId) { this.verified = true; return slot }
    }
    return this.admit()
  }

  private async admit(): Promise<FreebuffSlot> {
    const agentId = FREE_MODE_ROOT_AGENT[this.model]
    if (!agentId) throw new Error(`Freebuff model ${this.model} is not supported by Pocketbuff. Use one of: ${Object.keys(FREE_MODE_ROOT_AGENT).join(', ')}`)
    // Admission charges the slot up front, so check the price before claiming it.
    const prices = (await this.call('GET', '/api/v1/freebuff/session')).freebucks?.prices ?? {}
    const price = prices[this.model]
    if (price === undefined) throw new Error(`Freebuff does not currently offer ${this.model}. Zero-cost models right now: ${zeroCost(prices)}`)
    if (price > 0 && !this.options.allowFreebucks) throw new Error(`${this.model} costs ${price} Freebucks per session. Set FREEBUFF_ALLOW_FREEBUCKS=1 to allow it, or pick a zero-cost model: ${zeroCost(prices)}`)
    const body = await this.call('POST', '/api/v1/freebuff/session/admission', { 'x-freebuff-model': this.model, 'x-freebuff-wallet-spend-limit': '0' })
    if (body.status !== 'active' || !body.instanceId || !body.model || !body.expiresAt) throw new Error(`Freebuff did not admit a session: ${body.status ?? 'unknown'}${body.message ? ` - ${body.message}` : ''}`)
    const model = body.model
    const slot: FreebuffSlot = { instanceId: body.instanceId, model, agentId: FREE_MODE_ROOT_AGENT[model] ?? agentId, expiresAt: body.expiresAt }
    this.slot = slot; this.verified = true
    fs.mkdirSync(path.dirname(this.options.stateFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(this.options.stateFile, JSON.stringify(slot), { mode: 0o600 })
    return slot
  }

  private async call(method: 'GET' | 'POST' | 'DELETE', route: string, extra: Record<string, string> = {}): Promise<SessionResponse> {
    let timeZone = 'UTC'; try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } catch { /* keep UTC */ }
    const response = await this.fetch(this.baseUrl + route, { method, headers: { Authorization: `Bearer ${this.options.token}`, 'x-fb-timezone': timeZone, 'x-freebuff-first-tab-discount': '0', ...extra }, signal: AbortSignal.timeout(20_000) })
    if (response.status === 404 && method !== 'POST') return { status: 'none' }
    const text = await response.text()
    let body: SessionResponse = {}; try { body = JSON.parse(text) as SessionResponse } catch { /* non-JSON error */ }
    // 403/409/429 carry typed statuses (banned, model_locked, rate_limited...) that admit() reports.
    if (!response.ok && !body.status) throw new Error(`Freebuff session ${method} failed: ${response.status} ${text.slice(0, 200)}`)
    return body
  }
}

function zeroCost(prices: Record<string, number>) {
  return Object.entries(prices).filter(([model, price]) => price === 0 && FREE_MODE_ROOT_AGENT[model]).map(([model]) => model).join(', ') || 'none'
}
