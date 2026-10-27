import { CONFIG, type Heat } from './config'

/**
 * Pure drift scoring for one 60-second run. The game feeds one `DriftSample` per fixed step and
 * reacts to the returned events (audio, particles, UI). No three.js or DOM, so it is unit tested
 * and mirrored by the server's plausibility limits.
 */
export type DriftSample = {
  drifting: boolean
  /** Absolute slip angle in degrees. */
  angle: number
  speed: number
  inClip: boolean
  clipEntered: boolean
  nearMiss: boolean
  crash: boolean
  spin: boolean
}

export type Segment = {
  active: boolean
  /** Raw points before the multiplier. */
  points: number
  driftTime: number
  clips: number
  grace: number
  mult: number
  drifting: boolean
}

export type RunStats = { driftMs: number; clips: number; nearMisses: number; crashes: number; segments: number; bestSegment: number; maxMult: number; bestRating: number }

export type RunState = {
  phase: 'ready' | 'playing' | 'ended'
  elapsed: number
  timeLeft: number
  waited: number
  score: number
  heat: Heat
  seg: Segment
  stats: RunStats
}

export type DriftEvent =
  | { type: 'start' }
  | { type: 'segmentStart' }
  | { type: 'mult'; mult: number }
  | { type: 'clip'; bonus: number }
  | { type: 'nearMiss'; bonus: number }
  | { type: 'bank'; points: number; rating: number; mult: number }
  | { type: 'lost'; points: number; reason: 'crash' | 'spin' }
  | { type: 'heat'; heat: Heat }
  | { type: 'end' }

const S = CONFIG.score
const D = CONFIG.drift

export function emptySegment(): Segment {
  return { active: false, points: 0, driftTime: 0, clips: 0, grace: 0, mult: 1, drifting: false }
}

export function createRun(): RunState {
  return {
    phase: 'ready',
    elapsed: 0,
    timeLeft: CONFIG.run.seconds,
    waited: 0,
    score: 0,
    heat: 0,
    seg: emptySegment(),
    stats: { driftMs: 0, clips: 0, nearMisses: 0, crashes: 0, segments: 0, bestSegment: 0, maxMult: 1, bestRating: 0 },
  }
}

export function heatAt(elapsed: number): Heat {
  let h = 0
  for (let i = 0; i < S.heatAt.length; i += 1) if (elapsed >= S.heatAt[i]) h = i
  return h as Heat
}

export function angleFactor(angle: number): number {
  const t = (angle - D.minAngle) / (60 - D.minAngle)
  return Math.min(S.angleMax, Math.max(1, 1 + t * (S.angleMax - 1)))
}

export function speedFactor(speed: number): number {
  return Math.min(S.speedMax, Math.max(0.5, speed / 20))
}

export function multiplierFor(driftTime: number, clips: number): number {
  return Math.min(D.multMax, 1 + Math.floor(driftTime / D.multStep) + clips)
}

/** 0 = no rating, 1..6 = NICE .. DRIFT KING. */
export function ratingFor(points: number): number {
  let r = 0
  for (const t of S.ratings) if (points >= t) r += 1
  return r
}

/** Current value of the running segment if it banked now. */
export function segmentValue(seg: Segment): number {
  return seg.active ? Math.round(seg.points * seg.mult) : 0
}

function bank(run: RunState, events: DriftEvent[]): void {
  const seg = run.seg
  if (!seg.active) return
  const points = segmentValue(seg)
  const rating = ratingFor(points)
  run.score += points
  run.stats.segments += 1
  run.stats.bestSegment = Math.max(run.stats.bestSegment, points)
  run.stats.bestRating = Math.max(run.stats.bestRating, rating)
  events.push({ type: 'bank', points, rating, mult: seg.mult })
  run.seg = emptySegment()
}

function lose(run: RunState, reason: 'crash' | 'spin', events: DriftEvent[]): void {
  const points = segmentValue(run.seg)
  if (reason === 'crash') run.stats.crashes += 1
  events.push({ type: 'lost', points, reason })
  run.seg = emptySegment()
}

/** Wait for the first input (or the auto-start timeout) before the clock runs. */
export function stepReady(run: RunState, dt: number, anyInput: boolean, events: DriftEvent[]): RunState {
  if (run.phase !== 'ready') return run
  run.waited += dt
  if (anyInput || run.waited >= CONFIG.run.autoStart) {
    run.phase = 'playing'
    events.push({ type: 'start' })
  }
  return run
}

/** Advance the run by one fixed step. Mutates and returns `run` (hot path, 60 Hz). */
export function stepRun(run: RunState, dt: number, s: DriftSample, events: DriftEvent[]): RunState {
  if (run.phase !== 'playing') return run
  run.elapsed += dt
  run.timeLeft = Math.max(0, CONFIG.run.seconds - run.elapsed)
  const heat = heatAt(run.elapsed)
  if (heat !== run.heat) {
    run.heat = heat
    events.push({ type: 'heat', heat })
  }
  const seg = run.seg
  if (s.crash && seg.active) lose(run, 'crash', events)
  else if (s.crash) run.stats.crashes += 1
  else if (s.spin && seg.active) lose(run, 'spin', events)
  else if (s.drifting) {
    if (!seg.active) {
      seg.active = true
      events.push({ type: 'segmentStart' })
    }
    seg.drifting = true
    seg.grace = D.chainGrace[run.heat]
    seg.driftTime += dt
    run.stats.driftMs += dt * 1000
    const clipF = s.inClip ? S.clipFactor : 1
    seg.points += S.rate * angleFactor(s.angle) * speedFactor(s.speed) * S.heatMult[run.heat] * clipF * dt
    if (s.clipEntered) {
      seg.clips += 1
      run.stats.clips += 1
      const bonus = S.clipBonus * S.heatMult[run.heat]
      seg.points += bonus
      events.push({ type: 'clip', bonus })
    }
    if (s.nearMiss) {
      run.stats.nearMisses += 1
      const bonus = S.nearMissBonus * S.heatMult[run.heat]
      seg.points += bonus
      events.push({ type: 'nearMiss', bonus })
    }
    const mult = multiplierFor(seg.driftTime, seg.clips)
    if (mult > seg.mult) {
      seg.mult = mult
      run.stats.maxMult = Math.max(run.stats.maxMult, mult)
      events.push({ type: 'mult', mult })
    }
  } else if (seg.active) {
    seg.drifting = false
    seg.grace -= dt
    if (seg.grace <= 0) bank(run, events)
  }
  if (run.timeLeft <= 0) {
    // Time is up: an intact running segment still counts.
    bank(run, events)
    run.phase = 'ended'
    events.push({ type: 'end' })
  }
  return run
}

/** Upper bound of points a run could legitimately earn; the server applies the same formula. */
export function maxPlausibleScore(driftMs: number, events: number): number {
  const perSecond = S.rate * S.angleMax * S.speedMax * S.clipFactor * S.heatMult[3] * D.multMax
  const perEvent = Math.max(S.clipBonus, S.nearMissBonus) * S.heatMult[3] * D.multMax
  return Math.ceil((driftMs / 1000) * perSecond + events * perEvent)
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, seconds)
  return s >= 10 ? String(Math.ceil(s)) : s.toFixed(1)
}
