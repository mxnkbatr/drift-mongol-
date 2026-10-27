/**
 * Pure track geometry: a closed Catmull-Rom centreline resampled every ~2 m, with per-sample
 * tangent, left normal, cumulative distance and signed curvature. No three.js so it is unit tested
 * and shared by the mesh builder, the physics walls, the autopilot and the scoring rules.
 */
export type Vec2 = { x: number; z: number }
export type TrackSample = { x: number; z: number; tx: number; tz: number; nx: number; nz: number; s: number; curv: number }
export type Corner = { index: number; s: number; curv: number; dir: 1 | -1 }

import type { MapId } from '../engine/save'

/** Control points of the original circuit (metres). Start/finish sits on the long bottom straight. */
export const CONTROL_POINTS: [number, number][] = [
  [0, 0], [70, 0], [120, 8], [150, 40], [145, 85], [110, 100], [80, 120], [85, 160], [125, 175], [160, 205], [150, 250],
  [100, 265], [45, 250], [5, 262], [-45, 250], [-70, 210], [-45, 175], [-55, 130], [-95, 110], [-110, 65], [-80, 20], [-40, 4],
]

/** Public map catalog used by the title-screen route picker. */
export const MAPS: Record<MapId, { id: MapId; nameKey: string; descKey: string }> = {
  ub: { id: 'ub', nameKey: 'map.ub', descKey: 'map.ub.d' },
  steppe: { id: 'steppe', nameKey: 'map.steppe', descKey: 'map.steppe.d' },
  kharkhorin: { id: 'kharkhorin', nameKey: 'map.kharkhorin', descKey: 'map.kharkhorin.d' },
}

const STEPPE_POINTS: [number, number][] = CONTROL_POINTS.map(([x, z], i) => [x * 1.18 + (i % 2 ? 6 : -4), z * 0.72 - 24])
const KHARKHORIN_POINTS: [number, number][] = CONTROL_POINTS.map(([x, z], i) => [x * 0.84 - 14, z * 1.12 + (i % 3) * 5])

export function controlPointsForMap(mapId: MapId): [number, number][] {
  if (mapId === 'steppe') return STEPPE_POINTS
  if (mapId === 'kharkhorin') return KHARKHORIN_POINTS
  return CONTROL_POINTS
}
export const ROAD_WIDTH = 16
export const HALF_WIDTH = ROAD_WIDTH / 2

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

export function buildTrack(points: [number, number][] = CONTROL_POINTS, spacing = 2): TrackSample[] {
  const dense: Vec2[] = []
  const n = points.length
  for (let i = 0; i < n; i += 1) {
    const p0 = points[(i - 1 + n) % n]
    const p1 = points[i]
    const p2 = points[(i + 1) % n]
    const p3 = points[(i + 2) % n]
    const k = Math.max(4, Math.floor(Math.hypot(p2[0] - p1[0], p2[1] - p1[1])))
    for (let j = 0; j < k; j += 1) dense.push({ x: catmull(p0[0], p1[0], p2[0], p3[0], j / k), z: catmull(p0[1], p1[1], p2[1], p3[1], j / k) })
  }
  const cum = [0]
  for (let i = 1; i <= dense.length; i += 1) {
    const a = dense[i - 1]
    const b = dense[i % dense.length]
    cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z))
  }
  const total = cum[cum.length - 1]
  const count = Math.round(total / spacing)
  const out: TrackSample[] = []
  let j = 0
  for (let i = 0; i < count; i += 1) {
    const s = (total * i) / count
    while (cum[j + 1] < s) j += 1
    const a = dense[j]
    const b = dense[(j + 1) % dense.length]
    const t = (s - cum[j]) / (cum[j + 1] - cum[j])
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, tx: 0, tz: 0, nx: 0, nz: 0, s, curv: 0 })
  }
  for (let i = 0; i < count; i += 1) {
    const prev = out[(i - 1 + count) % count]
    const next = out[(i + 1) % count]
    const dx = next.x - prev.x
    const dz = next.z - prev.z
    const len = Math.hypot(dx, dz) || 1
    const p = out[i]
    p.tx = dx / len
    p.tz = dz / len
    // Left normal in the XZ plane (rotate tangent +90° around Y).
    p.nx = p.tz
    p.nz = -p.tx
  }
  for (let i = 0; i < count; i += 1) {
    const a = out[(i - 3 + count) % count]
    const b = out[(i + 3) % count]
    const cross = a.tx * b.tz - a.tz * b.tx
    const dot = a.tx * b.tx + a.tz * b.tz
    out[i].curv = Math.atan2(cross, dot) / (6 * spacing)
  }
  return out
}

export function trackLength(track: TrackSample[]): number {
  const last = track[track.length - 1]
  const first = track[0]
  return last.s + Math.hypot(first.x - last.x, first.z - last.z)
}

export type Projection = { index: number; lateral: number; along: number; dist: number }

/**
 * Nearest centreline sample to `p`, searching around `hint` first (cheap per-frame tracking) and
 * falling back to a full scan when the local result is implausible. `lateral` > 0 is left of travel.
 */
export function project(track: TrackSample[], p: Vec2, hint = -1): Projection {
  const n = track.length
  let best = -1
  let bestD = Infinity
  const scan = (from: number, to: number) => {
    for (let k = from; k <= to; k += 1) {
      const i = ((k % n) + n) % n
      const q = track[i]
      const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
  }
  if (hint >= 0) scan(hint - 25, hint + 25)
  if (best < 0 || bestD > 30 * 30) {
    bestD = Infinity
    scan(0, n - 1)
  }
  const q = track[best]
  const dx = p.x - q.x
  const dz = p.z - q.z
  return { index: best, lateral: dx * q.nx + dz * q.nz, along: dx * q.tx + dz * q.tz, dist: Math.sqrt(bestD) }
}

/** Local curvature maxima above `min` (1/m), at least `gap` samples apart: the drift corners. */
export function findCorners(track: TrackSample[], min = 1 / 45, gap = 18): Corner[] {
  const n = track.length
  const peaks: Corner[] = []
  for (let i = 0; i < n; i += 1) {
    const c = Math.abs(track[i].curv)
    if (c < min) continue
    let isPeak = true
    for (let k = -gap; k <= gap && isPeak; k += 1) {
      if (k === 0) continue
      const o = Math.abs(track[(i + k + n) % n].curv)
      if (o > c || (o === c && k < 0)) isPeak = false
    }
    if (isPeak) peaks.push({ index: i, s: track[i].s, curv: track[i].curv, dir: track[i].curv > 0 ? 1 : -1 })
  }
  return peaks
}

export function sampleAt(track: TrackSample[], index: number): TrackSample {
  const n = track.length
  return track[((index % n) + n) % n]
}
