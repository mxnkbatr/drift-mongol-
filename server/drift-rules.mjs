// Server-side plausibility rules for Drift King runs. Mirrors src/game/config.ts (score section)
// and src/game/rules.ts maxPlausibleScore; keep both in sync when tuning. The client reports its
// score and run statistics; anything outside what the rules could produce is rejected.
export const BOARD_ID = 'drift-v1';
export const RUN_SECONDS = 60;
const RATE = 60;
const ANGLE_MAX = 3;
const SPEED_MAX = 1.6;
const CLIP_FACTOR = 2;
const HEAT_MAX = 3;
const MULT_MAX = 10;
const EVENT_BONUS = 250;
export const SCORE_CAP = 1_500_000;
/** A run spends 60 s of game time plus up to 3 s waiting for the first input. */
export const MIN_SERVER_ELAPSED_MS = 57_000;

const fail = (code) => { throw Object.assign(new Error(code), { status: 422, code }); };
const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;

export function maxPlausibleScore(driftMs, events) {
  const perSecond = RATE * ANGLE_MAX * SPEED_MAX * CLIP_FACTOR * HEAT_MAX * MULT_MAX;
  const perEvent = EVENT_BONUS * HEAT_MAX * MULT_MAX;
  return Math.ceil((driftMs / 1000) * perSecond + events * perEvent);
}

/** Validate a submission body; throws 400/422 with a stable error code. */
export function validateDriftRun(data) {
  if (!int(data.score, 0, SCORE_CAP) || !int(data.durationMs, 0, 1_800_000)) throw Object.assign(new Error('invalid_score'), { status: 400, code: 'invalid_score' });
  const s = data.stats;
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw Object.assign(new Error('invalid_stats'), { status: 400, code: 'invalid_stats' });
  const keys = ['driftMs', 'clips', 'nearMisses', 'segments', 'maxMult', 'crashes'];
  if (Object.keys(s).some((k) => !keys.includes(k))) throw Object.assign(new Error('invalid_stats'), { status: 400, code: 'invalid_stats' });
  if (!int(s.driftMs, 0, RUN_SECONDS * 1000 + 500) || !int(s.clips, 0, 80) || !int(s.nearMisses, 0, 80) || !int(s.segments, 0, 300) || !int(s.maxMult, 1, MULT_MAX) || !int(s.crashes, 0, 1000)) fail('stats_outside_rules');
  if (data.durationMs < RUN_SECONDS * 1000 - 1500) fail('run_too_short');
  if (data.score > 0 && (s.segments < 1 || s.driftMs < 200)) fail('score_without_drift');
  if (data.score > maxPlausibleScore(s.driftMs, s.clips + s.nearMisses)) fail('score_implausible');
  // Every banked segment needs at least one fixed step (1/60 s) of drifting.
  if (s.segments * 16 > s.driftMs + 100) fail('stats_inconsistent');
  return { score: data.score, durationMs: data.durationMs, stats: keys.reduce((o, k) => ({ ...o, [k]: s[k] }), {}) };
}

export const dayBoard = (day) => `${BOARD_ID}@${day}`;
export const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);
