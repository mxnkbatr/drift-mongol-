/**
 * Versioned local save. Everything the player keeps between sessions lives in one JSON record so
 * it is easy to migrate. Corrupt or foreign data falls back to defaults instead of crashing.
 */
export type Locale = 'en' | 'zh-CN' | 'mn'
export type Quality = 'low' | 'medium' | 'high'
export type ScoreEntry = { score: number; at: number; day: string }
export type Guest = { playerId: string; token: string; name: string }

export type SaveData = {
  version: 1
  /** '' = never chosen; the game follows the browser language until the player picks one. */
  locale: Locale | ''
  musicVolume: number
  sfxVolume: number
  muted: boolean
  quality: Quality
  reducedMotion: boolean
  tutorialDone: boolean
  /** Nickname for the online boards; '' until the player enters one. */
  playerName: string
  best: number
  bestDay: { day: string; score: number }
  runs: number
  guest: Guest | null
  history: ScoreEntry[]
}

export const SAVE_KEY = 'driftking.save'
export const HISTORY_SIZE = 10

export function defaultSave(): SaveData {
  return {
    version: 1,
    locale: '',
    musicVolume: 0.6,
    sfxVolume: 0.85,
    muted: false,
    quality: 'high',
    reducedMotion: false,
    tutorialDone: false,
    playerName: '',
    best: 0,
    bestDay: { day: '', score: 0 },
    runs: 0,
    guest: null,
    history: [],
  }
}

const clamp01 = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback)
const nonNeg = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

/** Parse untrusted stored JSON into a valid SaveData (pure; unit tested). */
export function parseSave(raw: string | null): SaveData {
  const base = defaultSave()
  if (!raw) return base
  let data: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base
    data = parsed as Record<string, unknown>
  } catch {
    return base
  }
  if (data.version !== 1) return base
  const bd = (data.bestDay ?? {}) as Record<string, unknown>
  const g = data.guest as Record<string, unknown> | null | undefined
  const guest = g && typeof g === 'object' && typeof g.playerId === 'string' && typeof g.token === 'string' && g.token.length > 10 ? { playerId: str(g.playerId, 80), token: str(g.token, 400), name: str(g.name, 16) } : null
  const history = Array.isArray(data.history) ? data.history : []
  return {
    version: 1,
    locale: data.locale === 'en' || data.locale === 'zh-CN' || data.locale === 'mn' ? data.locale : '',
    musicVolume: clamp01(data.musicVolume, base.musicVolume),
    sfxVolume: clamp01(data.sfxVolume, base.sfxVolume),
    muted: data.muted === true,
    quality: data.quality === 'low' || data.quality === 'medium' || data.quality === 'high' ? data.quality : base.quality,
    reducedMotion: data.reducedMotion === true,
    tutorialDone: data.tutorialDone === true,
    playerName: str(data.playerName, 16).trim(),
    best: nonNeg(data.best),
    bestDay: { day: str(bd.day, 10), score: nonNeg(bd.score) },
    runs: nonNeg(data.runs),
    guest,
    history: history
      .filter((e): e is ScoreEntry => !!e && typeof e === 'object' && Number.isFinite((e as ScoreEntry).score))
      .map(e => ({ score: nonNeg(e.score), at: nonNeg(e.at), day: str(e.day, 10) }))
      .slice(0, HISTORY_SIZE),
  }
}

/** Insert a run into the bounded personal history (higher score first, then earlier). */
export function insertScore(history: ScoreEntry[], entry: ScoreEntry): { history: ScoreEntry[]; rank: number } {
  const next = [...history, entry].sort((a, b) => b.score - a.score || a.at - b.at).slice(0, HISTORY_SIZE)
  return { history: next, rank: next.indexOf(entry) }
}

export class SaveStore {
  data: SaveData
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage) {
    let raw: string | null = null
    try {
      raw = this.storage?.getItem(SAVE_KEY) ?? null
    } catch {
      raw = null
    }
    this.data = parseSave(raw)
  }

  update(patch: Partial<SaveData>): void {
    this.data = { ...this.data, ...patch }
    try {
      this.storage?.setItem(SAVE_KEY, JSON.stringify(this.data))
    } catch {
      // Private browsing or quota: the game keeps working with in-memory settings.
    }
  }
}
