import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM server module without type declarations
import { maxPlausibleScore as serverMax, validateDriftRun } from '../server/drift-rules.mjs'
import { CONFIG } from '../src/game/config'
import { dailyFor, dayKey } from '../src/game/daily'
import { createRun, type DriftEvent, type DriftSample, maxPlausibleScore, ratingFor, stepReady, stepRun } from '../src/game/rules'
import { buildTrack, findCorners } from '../src/game/track'
import { challengeUrl, decodeChallenge, encodeChallenge } from '../src/online/challenge'

const DT = 1 / 60
const idle: DriftSample = { drifting: false, angle: 0, speed: 20, inClip: false, clipEntered: false, nearMiss: false, crash: false, spin: false }
const slide = (o: Partial<DriftSample> = {}): DriftSample => ({ ...idle, drifting: true, angle: 35, speed: 24, ...o })

function playing() {
  const run = createRun()
  stepReady(run, DT, true, [])
  return run
}
function steps(run: ReturnType<typeof createRun>, n: number, s: DriftSample, events: DriftEvent[] = []) {
  for (let i = 0; i < n; i += 1) stepRun(run, DT, s, events)
  return events
}

describe('drift scoring', () => {
  it('banks a drift after the chain grace expires', () => {
    const run = playing()
    const ev = steps(run, 90, slide())
    expect(ev.some(e => e.type === 'segmentStart')).toBe(true)
    expect(run.score).toBe(0)
    steps(run, 120, idle, ev)
    const bank = ev.find(e => e.type === 'bank')
    expect(bank && bank.type === 'bank' && bank.points).toBeGreaterThan(0)
    expect(run.score).toBeGreaterThan(0)
    expect(run.stats.segments).toBe(1)
  })

  it('pays more for bigger angles and longer slides', () => {
    const bankFor = (angle: number, frames: number) => {
      const run = playing()
      steps(run, frames, slide({ angle }))
      steps(run, 120, idle)
      return run.score
    }
    expect(bankFor(45, 120)).toBeGreaterThan(bankFor(20, 120))
    // Multiplier growth makes the payoff super-linear in drift length.
    expect(bankFor(35, 360)).toBeGreaterThan(bankFor(35, 120) * 3)
  })

  it('a wall hit wipes the running segment but keeps the banked score', () => {
    const run = playing()
    steps(run, 90, slide())
    steps(run, 120, idle)
    const banked = run.score
    const ev = steps(run, 90, slide())
    steps(run, 1, { ...idle, crash: true }, ev)
    expect(ev.some(e => e.type === 'lost')).toBe(true)
    expect(run.seg.active).toBe(false)
    steps(run, 120, idle)
    expect(run.score).toBe(banked)
  })

  it('clip zones add a bonus and a multiplier bump', () => {
    const plain = playing()
    steps(plain, 90, slide())
    steps(plain, 120, idle)
    const clipped = playing()
    steps(clipped, 1, slide({ inClip: true, clipEntered: true }))
    steps(clipped, 89, slide({ inClip: true }))
    steps(clipped, 120, idle)
    expect(clipped.score).toBeGreaterThan(plain.score * 1.8)
    expect(clipped.stats.clips).toBe(1)
  })

  it('heat rises through the run and time-up banks the live segment', () => {
    const run = playing()
    const ev: DriftEvent[] = []
    steps(run, 60 * 58, idle, ev)
    expect(ev.filter(e => e.type === 'heat').length).toBe(CONFIG.score.heatAt.length - 1)
    steps(run, 60 * 3, slide(), ev)
    expect(run.phase).toBe('ended')
    expect(ev.some(e => e.type === 'bank')).toBe(true)
    expect(ev.at(-1)?.type).toBe('end')
  })

  it('ratings climb with points', () => {
    expect(ratingFor(0)).toBe(0)
    expect(ratingFor(CONFIG.score.ratings[0])).toBeGreaterThanOrEqual(1)
    expect(ratingFor(10_000_000)).toBe(CONFIG.score.ratings.length)
  })
})

describe('server plausibility mirrors the client rules', () => {
  it('uses the same upper bound formula', () => {
    for (const [ms, ev] of [[0, 0], [12_000, 3], [45_000, 11], [60_000, 40]]) expect(serverMax(ms, ev)).toBe(maxPlausibleScore(ms, ev))
  })

  it('accepts a perfect simulated run and the max plausible score', () => {
    const run = playing()
    let clips = 0
    while (run.phase === 'playing') {
      const enter = run.elapsed % 6 < DT
      if (enter) clips += 1
      stepRun(run, DT, slide({ angle: 90, speed: 60, inClip: true, clipEntered: enter }), [])
    }
    const stats = { driftMs: Math.round(run.stats.driftMs), clips, nearMisses: 0, segments: run.stats.segments, maxMult: run.stats.maxMult, crashes: 0 }
    expect(() => validateDriftRun({ score: Math.round(run.score), durationMs: 60_400, stats })).not.toThrow()
  })

  it('accepts many tiny novice slides', () => {
    const run = playing()
    while (run.phase === 'playing') {
      steps(run, 2, slide({ angle: 14, speed: 9 }))
      steps(run, 100, idle)
    }
    const stats = { driftMs: Math.round(run.stats.driftMs), clips: 0, nearMisses: 0, segments: run.stats.segments, maxMult: run.stats.maxMult, crashes: 3 }
    expect(stats.segments).toBeGreaterThan(20)
    expect(() => validateDriftRun({ score: Math.round(run.score), durationMs: 61_000, stats })).not.toThrow()
  })

  it('rejects impossible submissions', () => {
    const stats = { driftMs: 3000, clips: 0, nearMisses: 0, segments: 2, maxMult: 3, crashes: 0 }
    expect(() => validateDriftRun({ score: 500_000, durationMs: 61_000, stats })).toThrow('score_implausible')
    expect(() => validateDriftRun({ score: 100, durationMs: 20_000, stats })).toThrow('run_too_short')
    expect(() => validateDriftRun({ score: 100, durationMs: 61_000, stats: { ...stats, driftMs: 0, segments: 0 } })).toThrow('score_without_drift')
    expect(() => validateDriftRun({ score: 100, durationMs: 61_000, stats: { ...stats, maxMult: 99 } })).toThrow('stats_outside_rules')
  })
})

describe("today's challenge", () => {
  const track = buildTrack()
  const corners = findCorners(track)
  it('is identical for everyone on the same day', () => {
    const a = dailyFor('2026-09-26', track, corners)
    const b = dailyFor('2026-09-26', track, corners)
    expect(a).toEqual(b)
    expect(a.clips.length).toBe(Math.min(CONFIG.clip.perDay, corners.length))
  })
  it('changes weather day to day through every condition', () => {
    const seen = new Set<string>()
    for (let d = 0; d < 5; d += 1) seen.add(dailyFor(dayKey(new Date(Date.UTC(2026, 8, 20 + d))), track, corners).condition.id)
    expect(seen.size).toBe(5)
  })
})

describe('challenge links', () => {
  it('round-trips score, name and day, including CJK names', () => {
    const c = { score: 30736, name: '阿飞 Drift', day: '2026-09-26' }
    expect(decodeChallenge(encodeChallenge(c))).toEqual(c)
    const url = new URL(challengeUrl(c, 'https://example.test/play?x=1#top'))
    expect(decodeChallenge(url.searchParams.get('vs'))).toEqual(c)
  })
  it('rejects garbage and hostile tokens', () => {
    expect(decodeChallenge('%%%')).toBeNull()
    expect(decodeChallenge(null)).toBeNull()
    expect(decodeChallenge(encodeChallenge({ score: -5, name: 'x', day: '2026-09-26' }))).toBeNull()
    const hostile = decodeChallenge(encodeChallenge({ score: 10, name: '<img src=x>', day: '2026-09-26' }))
    expect(hostile?.name.includes('<')).toBeFalsy()
  })
})
