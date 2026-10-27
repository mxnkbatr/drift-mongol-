// End-to-end protocol test against a LOCAL throwaway database only (never the managed DB).
// Usage: node scripts/api-test.mjs http://127.0.0.1:8080  (backdates runs through `sudo mysql dk_local`)
import { execSync } from 'node:child_process'

const base = `${process.argv[2] ?? 'http://127.0.0.1:8080'}/api/leaderboards/v1/`
let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!cond) failures += 1
}
async function call(method, path, body, token, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data }
}
const backdate = (runId, seconds = 62) => execSync(`sudo mysql dk_local -e "UPDATE game_lb_runs SET issued_at = issued_at - INTERVAL ${seconds} SECOND WHERE id='${runId}'"`)
const stats = (o = {}) => ({ driftMs: 30000, clips: 2, nearMisses: 1, segments: 8, maxMult: 8, crashes: 1, ...o })
const tag = Date.now().toString(36).slice(-4)

const health = await call('GET', 'health')
check('health ok', health.status === 200 && health.data?.status === 'ok', JSON.stringify(health.data))

const a = await call('POST', 'guests', { displayName: `阿飞${tag}` })
const b = await call('POST', 'guests', { displayName: `Bob${tag}` })
check('guest A created', a.status === 201 && a.data.token?.length === 43)
check('guest B created', b.status === 201)
const long = await call('POST', 'guests', { displayName: 'x'.repeat(17) })
check('name > 16 chars rejected', long.status === 400, JSON.stringify(long.data))
const html = await call('POST', 'guests', { displayName: '<b>hi</b>' })
check('name with angle brackets rejected', html.status === 400)

async function play(token, score, s = stats(), durationMs = 61200, back = 62) {
  const run = await call('POST', 'boards/drift-v1/runs', { protocolVersion: 1, rulesVersion: 'v1' }, token)
  if (run.status !== 201) return { status: run.status, data: run.data }
  if (back) backdate(run.data.runId, back)
  const sub = await call('PUT', `runs/${run.data.runId}`, { score, durationMs, stats: s }, token)
  return { ...sub, runId: run.data.runId }
}

const r1 = await play(a.data.token, 32000)
check('valid run A accepted', r1.status === 200 && r1.data.accepted === true, JSON.stringify(r1.data))
check('receipt has today/all standing', r1.data?.today?.rank >= 1 && r1.data?.all?.total >= 1)
const r2 = await play(b.data.token, 21000)
check('valid run B accepted', r2.status === 200, JSON.stringify(r2.data))
check('B ranks below A today', r2.data?.today?.rank >= 2, JSON.stringify(r2.data?.today))
const r3 = await play(b.data.token, 45000, stats({ driftMs: 36000 }))
check('B improves best', r3.status === 200 && r3.data.today.best === 45000, JSON.stringify(r3.data?.today))
check('B beats A (beaten >= 1)', r3.data?.today?.beaten >= 1)

// Idempotent replay and conflicting replay.
const replay = await call('PUT', `runs/${r1.runId}`, { score: 32000, durationMs: 61200, stats: stats() }, a.data.token)
check('identical replay is idempotent', replay.status === 200 && replay.data.score === 32000, `${replay.status}`)
const conflict = await call('PUT', `runs/${r1.runId}`, { score: 99999, durationMs: 61200, stats: stats() }, a.data.token)
check('changed replay rejected', conflict.status >= 400, `${conflict.status} ${JSON.stringify(conflict.data)}`)

// Anti-cheat.
const impl = await play(a.data.token, 900000, stats({ driftMs: 2000, clips: 0, nearMisses: 0, segments: 2 }))
check('implausible score rejected', impl.status === 422 && impl.data.error === 'score_implausible', JSON.stringify(impl.data))
const cap = await play(a.data.token, 2_000_000)
check('score over cap rejected', cap.status === 400 || cap.status === 422, JSON.stringify(cap.data))
const fast = await play(a.data.token, 5000, stats(), 61200, 0)
check('submit before 57 s of server time rejected', fast.status === 422 && fast.data.error === 'run_too_fast', JSON.stringify(fast.data))
const short = await play(a.data.token, 5000, stats(), 30000)
check('short run rejected', short.status === 422, JSON.stringify(short.data))
const long2 = await play(a.data.token, 5000, stats(), 200000)
check('duration beyond server clock rejected', long2.status === 422, JSON.stringify(long2.data))
const noDrift = await play(a.data.token, 5000, stats({ driftMs: 0, segments: 0 }))
check('score without drift rejected', noDrift.status === 422, JSON.stringify(noDrift.data))
const badStats = await play(a.data.token, 5000, { ...stats(), hacked: 1 })
check('unknown stats field rejected', badStats.status === 400, JSON.stringify(badStats.data))
const extra = await (async () => {
  const run = await call('POST', 'boards/drift-v1/runs', { protocolVersion: 1, rulesVersion: 'v1' }, a.data.token)
  backdate(run.data.runId)
  return call('PUT', `runs/${run.data.runId}`, { score: 10, durationMs: 61000, stats: stats(), bonus: 1 }, a.data.token)
})()
check('unknown body field rejected', extra.status === 400)
const wrongRules = await call('POST', 'boards/drift-v1/runs', { protocolVersion: 1, rulesVersion: 'v0' }, a.data.token)
check('stale rules version rejected', wrongRules.status >= 400, `${wrongRules.status} ${JSON.stringify(wrongRules.data)}`)
const noAuth = await call('POST', 'boards/drift-v1/runs', { protocolVersion: 1, rulesVersion: 'v1' })
check('run without guest session rejected', noAuth.status === 401)
const other = await call('PUT', `runs/${r2.runId}`, { score: 21000, durationMs: 61200, stats: stats() }, a.data.token)
check("cannot submit another player's run", other.status >= 400, `${other.status}`)
const cross = await call('GET', 'boards/drift-v1', undefined, undefined, { 'Sec-Fetch-Site': 'cross-site' })
check('cross-site request rejected', cross.status === 403)

// Reads.
const day = await call('GET', 'boards/drift-v1?scope=day&limit=20', undefined, a.data.token)
check('today board readable', day.status === 200 && Array.isArray(day.data.entries) && day.data.scope === 'day', `total ${day.data?.total}`)
check('today board marks me', day.data.entries.some(e => e.me) && day.data.myRank?.rank >= 1)
const all = await call('GET', 'boards/drift-v1?scope=all&limit=5')
check('all-time board readable anonymously', all.status === 200 && all.data.entries.length >= 2 && all.data.myRank === null)
const sorted = all.data.entries.every((e, i, arr) => i === 0 || arr[i - 1].score >= e.score)
check('all-time board sorted desc', sorted)
const badScope = await call('GET', 'boards/drift-v1?scope=week')
check('bad scope rejected', badScope.status === 400)

// Rename.
const ren = await call('PUT', 'players/me', { displayName: `飞${tag}` }, a.data.token)
check('rename works', ren.status === 200 && ren.data.displayName === `飞${tag}`)
const after = await call('GET', 'boards/drift-v1?scope=all&limit=100')
check('rename visible on board', after.data.entries.some(e => e.displayName === `飞${tag}`))

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
