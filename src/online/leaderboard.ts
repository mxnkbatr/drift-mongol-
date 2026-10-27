import type { Guest } from '../engine/save'

/**
 * Client for the game's own leaderboard API (server/server.mjs). All paths are relative to the
 * page so managed Preview ingress prefixes survive. Offline play never depends on this: every call
 * fails soft with a typed error the UI can show.
 */
export const BOARD = 'drift-v1'
export const RULES_VERSION = 'v1'
const PROTOCOL = 1

export type Scope = 'day' | 'all'
export type Entry = { playerId: string; displayName: string; score: number; rank: number; me: boolean }
export type BoardView = { scope: Scope; total: number; entries: Entry[]; myRank: { rank: number; score: number } | null }
export type Standing = { rank: number; total: number; beaten: number; best: number }
export type Receipt = { runId: string; score: number; day: string; all: Standing; today: Standing }
export type RunStats = { driftMs: number; clips: number; nearMisses: number; segments: number; maxMult: number; crashes: number }
export type OnlineErrorCode = 'offline' | 'rejected' | 'rate' | 'upgrade' | 'expired' | 'name' | 'busy'

export class OnlineError extends Error {
  constructor(readonly code: OnlineErrorCode, readonly detail = '') {
    super(`${code}${detail ? `:${detail}` : ''}`)
  }
}

type Fetcher = typeof fetch

export class Leaderboard {
  /** Set after a 426: ranked writes stay off until the page reloads; reads still work. */
  upgradeRequired = false
  private base: string

  constructor(
    private guest: Guest | null,
    private readonly saveGuest: (g: Guest | null) => void,
    href = window.location.href,
    private readonly fetcher: Fetcher = (...args) => fetch(...args),
  ) {
    const configuredOrigin = String(import.meta.env.VITE_API_BASE_URL ?? '').trim()
    this.base = configuredOrigin
      ? new URL('/api/leaderboards/v1/', `${configuredOrigin.replace(/\/+$/, '')}/`).toString()
      : new URL('./api/leaderboards/v1/', href).toString()
  }

  get identity(): Guest | null {
    return this.guest
  }

  private async call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    if (import.meta.env.DEV && !/[?&]online=1/.test(window.location.search)) throw new OnlineError('offline')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 9000)
    let res: Response
    try {
      const headers: Record<string, string> = {}
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      if (auth && this.guest) headers.Authorization = `Bearer ${this.guest.token}`
      res = await this.fetcher(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal, credentials: 'same-origin' })
    } catch {
      throw new OnlineError('offline')
    } finally {
      clearTimeout(timer)
    }
    let data: Record<string, unknown> = {}
    try {
      data = (await res.json()) as Record<string, unknown>
    } catch {
      // Dev preview / static hosting answers /api with HTML or nothing: treat as offline.
      throw new OnlineError('offline')
    }
    if (res.ok) return data as T
    const code = String(data.error ?? res.status)
    if (res.status === 401) {
      this.guest = null
      this.saveGuest(null)
      throw new OnlineError('expired', code)
    }
    if (res.status === 426) {
      this.upgradeRequired = true
      throw new OnlineError('upgrade', code)
    }
    if (res.status === 429) throw new OnlineError('rate', code)
    if (res.status === 400 && code === 'invalid_display_name') throw new OnlineError('name', code)
    if (res.status === 422 || res.status === 409 || res.status === 400) throw new OnlineError('rejected', code)
    if (res.status === 410) throw new OnlineError('expired', code)
    if (res.status === 503 || res.status === 504) throw new OnlineError('busy', code)
    throw new OnlineError('offline', code)
  }

  async ensureGuest(name: string): Promise<Guest> {
    if (this.guest) return this.guest
    const data = await this.call<{ playerId: string; token: string; displayName: string }>('POST', 'guests', { displayName: name }, false)
    this.guest = { playerId: data.playerId, token: data.token, name: data.displayName }
    this.saveGuest(this.guest)
    return this.guest
  }

  /** Ask the server for a run ticket when the clock starts (duration is checked against it). */
  async beginRun(fallbackName: string): Promise<string> {
    if (this.upgradeRequired) throw new OnlineError('upgrade')
    const attempt = async () => {
      await this.ensureGuest(fallbackName)
      const data = await this.call<{ runId: string }>('POST', `boards/${BOARD}/runs`, { protocolVersion: PROTOCOL, rulesVersion: RULES_VERSION })
      return data.runId
    }
    try {
      return await attempt()
    } catch (e) {
      // An expired guest session gets one fresh identity.
      if (e instanceof OnlineError && e.code === 'expired' && !this.guest) return attempt()
      throw e
    }
  }

  async rename(name: string): Promise<void> {
    if (!this.guest) {
      await this.ensureGuest(name)
      return
    }
    if (this.guest.name === name) return
    const data = await this.call<{ displayName: string }>('PUT', 'players/me', { displayName: name })
    this.guest = { ...this.guest, name: data.displayName }
    this.saveGuest(this.guest)
  }

  /** Submit once; network failures retry with the identical payload (the server is idempotent). */
  async submit(runId: string, score: number, durationMs: number, stats: RunStats): Promise<Receipt> {
    const body = { score, durationMs, stats }
    let last: unknown
    for (let i = 0; i < 3; i += 1) {
      try {
        return await this.call<Receipt>('PUT', `runs/${runId}`, body)
      } catch (e) {
        last = e
        if (!(e instanceof OnlineError) || (e.code !== 'offline' && e.code !== 'busy')) throw e
        await new Promise(r => setTimeout(r, 600 * (i + 1)))
      }
    }
    throw last
  }

  async board(scope: Scope, limit = 20): Promise<BoardView> {
    const q = scope === 'day' ? `scope=day&day=${new Date().toISOString().slice(0, 10)}` : 'scope=all'
    const data = await this.call<BoardView>('GET', `boards/${BOARD}?${q}&limit=${limit}`, undefined, true)
    return { scope, total: Number(data.total) || 0, entries: Array.isArray(data.entries) ? data.entries : [], myRank: data.myRank ?? null }
  }
}

/** "Beat X% of drivers" from a standing (0-100, integer). */
export function beatenPercent(s: Standing): number {
  const others = s.total - 1
  if (others <= 0) return 100
  return Math.max(0, Math.min(100, Math.floor((s.beaten / others) * 100)))
}
