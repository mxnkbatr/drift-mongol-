/**
 * "Today's Challenge": the UTC date picks the weather/time of day and which corners carry clip
 * zones, so every player drives the identical run on a given day. Pure (no three.js).
 */
import { CONFIG } from './config'
import type { Corner, TrackSample } from './track'

export type ConditionId = 'night' | 'rain' | 'dusk' | 'fog' | 'dawn'

export type Condition = {
  id: ConditionId
  /** Grip multiplier (rain is slippery: easier to break loose, harder to hold). */
  grip: number
  skyTop: string
  skyHorizon: string
  fog: string
  fogDensity: number
  hemiSky: string
  hemiGround: string
  hemi: number
  sun: string
  sunIntensity: number
  sunElevation: number
  windows: number
  lamps: number
  road: string
  roadRoughness: number
  rain: boolean
  stars: boolean
  exposure: number
}

export const CONDITIONS: Record<ConditionId, Condition> = {
  night: { id: 'night', grip: 1, skyTop: '#060818', skyHorizon: '#2a1b55', fog: '#171133', fogDensity: 0.0045, hemiSky: '#6c78d8', hemiGround: '#1a1030', hemi: 1.0, sun: '#9fb4ff', sunIntensity: 0.95, sunElevation: 0.9, windows: 1.25, lamps: 1.2, road: '#6b6e8c', roadRoughness: 0.82, rain: false, stars: true, exposure: 1.3 },
  rain: { id: 'rain', grip: 0.86, skyTop: '#05070d', skyHorizon: '#1d2a3f', fog: '#141c2b', fogDensity: 0.0072, hemiSky: '#6d87b8', hemiGround: '#0f1522', hemi: 0.95, sun: '#8fa6d8', sunIntensity: 0.7, sunElevation: 0.9, windows: 1.3, lamps: 1.4, road: '#666e94', roadRoughness: 0.28, rain: true, stars: false, exposure: 1.28 },
  dusk: { id: 'dusk', grip: 1, skyTop: '#2c2a6e', skyHorizon: '#ff8a4c', fog: '#5e3a5e', fogDensity: 0.0024, hemiSky: '#ffb38a', hemiGround: '#3a2440', hemi: 1.0, sun: '#ffab6b', sunIntensity: 1.7, sunElevation: 0.16, windows: 0.75, lamps: 0.8, road: '#6a6276', roadRoughness: 0.8, rain: false, stars: false, exposure: 1.12 },
  fog: { id: 'fog', grip: 0.95, skyTop: '#130b26', skyHorizon: '#4a2a6a', fog: '#3a2458', fogDensity: 0.0105, hemiSky: '#b58cff', hemiGround: '#20123a', hemi: 1.05, sun: '#d2a8ff', sunIntensity: 0.7, sunElevation: 0.8, windows: 1.4, lamps: 1.5, road: '#625a78', roadRoughness: 0.7, rain: false, stars: false, exposure: 1.22 },
  dawn: { id: 'dawn', grip: 1, skyTop: '#3d5fa8', skyHorizon: '#ffc2b0', fog: '#a8a0c4', fogDensity: 0.0034, hemiSky: '#cfe0ff', hemiGround: '#4a3a50', hemi: 1.15, sun: '#ffd6b0', sunIntensity: 1.5, sunElevation: 0.22, windows: 0.45, lamps: 0.4, road: '#6c6e80', roadRoughness: 0.78, rain: false, stars: false, exposure: 1.05 },
}

const ORDER: ConditionId[] = ['night', 'rain', 'dusk', 'fog', 'dawn']

/** UTC calendar day, e.g. "2026-09-26". The daily board uses the same boundary. */
export function dayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

/** FNV-1a string hash → 32-bit seed. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Mulberry32: tiny deterministic RNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type ClipSpot = { index: number; x: number; z: number; side: 1 | -1; lateral: number }

export type Daily = { day: string; seed: number; condition: Condition; clips: ClipSpot[] }

/**
 * Pick the day's condition and clip zones. Condition cycles so consecutive days always differ;
 * clip zones sit on the outside (or occasionally the inside apex) of a seeded subset of corners.
 */
export function dailyFor(day: string, track: TrackSample[], corners: Corner[]): Daily {
  const seed = hashSeed(`drift-king:${day}`)
  const r = rng(seed)
  const dayNumber = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000)
  const condition = CONDITIONS[ORDER[((dayNumber % ORDER.length) + ORDER.length) % ORDER.length]]
  const pool = corners.slice()
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  const chosen = pool.slice(0, Math.min(CONFIG.clip.perDay, pool.length)).sort((a, b) => a.index - b.index)
  const clips = chosen.map(c => {
    const p = track[c.index]
    // curv > 0 turns right, so the outside of the corner is the left side (+lateral).
    const outside: 1 | -1 = c.curv > 0 ? 1 : -1
    const side: 1 | -1 = r() < 0.75 ? outside : ((-outside) as 1 | -1)
    const lateral = side * (side === outside ? 5.2 : 4.4)
    return { index: c.index, x: p.x + p.nx * lateral, z: p.z + p.nz * lateral, side, lateral }
  })
  return { day, seed, condition, clips }
}
