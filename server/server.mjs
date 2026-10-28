import { readBackendContract } from './backend-contract.mjs';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { createRequestDatabase, databaseStream, DATABASE_CONCURRENCY } from './request-database.mjs';
import { previousSubmission, assertClientRules, assertRunRules, assertDatabaseEnvironment, assertDatabaseReady, databaseName, PROTOCOL_VERSION, SCHEMA_VERSION } from './deployment-contract.mjs';
import { BOARD_ID, dayBoard, MIN_SERVER_ELAPSED_MS, utcDay, validateDriftRun } from './drift-rules.mjs';
// Drift King leaderboard API (adapted from the Webdev leaderboard reference). One ranked board
// ("drift-v1") keeps two best tables: all-time (board_id = drift-v1) and per UTC day
// (board_id = drift-v1@YYYY-MM-DD). This server belongs to the game, never to Addon Server.
const backendContract = readBackendContract(process.cwd(), { required: true }).value;
if (backendContract.api.protocolVersion !== PROTOCOL_VERSION || backendContract.database.schemaVersion !== SCHEMA_VERSION || !['/api/health','/api/leaderboards/v1/health'].includes(backendContract.deploy.healthPath)) throw new Error('backend_contract_incompatible');
const namespace = 'production';
const readonly = process.env.GAME_LEADERBOARD_READ_ONLY === '1';
if (!process.env.DATABASE_URL) throw new Error('Project DATABASE_URL is required');
databaseName(process.env.DATABASE_URL);
const pool = mysql.createPool({ uri: process.env.DATABASE_URL, stream: databaseStream(process.env.DATABASE_URL), connectionLimit: DATABASE_CONCURRENCY, waitForConnections: false, connectTimeout: 3000, timezone: 'Z', dateStrings: true });
const db = createRequestDatabase(pool);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const uuidPattern = /^[0-9a-f-]{36}$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const prefix = '/api/leaderboards/v1';
const corsOrigins = new Set(['capacitor://localhost', 'ionic://localhost', 'https://localhost', ...String(process.env.GAME_CORS_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean)]);
function corsAllowed(req) {
  const origin = String(req.headers.origin || '');
  return !origin || corsOrigins.has(origin);
}
function applyCors(req, res) {
  const origin = String(req.headers.origin || '');
  if (!origin || !corsOrigins.has(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  return true;
}
const send = (res, status, data) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
};
async function rateLimit(key, maximum) {
  const bucket = digest(key);
  const window = Math.floor(Date.now() / 60_000);
  const count = await db.transaction(async (conn) => {
    await conn.execute('INSERT IGNORE INTO game_lb_rate_limits (namespace,bucket_hash,window_start,request_count) VALUES (?, ?, ?, 0)', [namespace, bucket, window]);
    const [[row]] = await conn.execute('SELECT window_start, request_count FROM game_lb_rate_limits WHERE namespace=? AND bucket_hash=? FOR UPDATE', [namespace, bucket]);
    const next = Number(row.window_start) === window ? Math.min(Number(row.request_count) + 1, 4294967295) : 1;
    await conn.execute('UPDATE game_lb_rate_limits SET window_start=?, request_count=? WHERE namespace=? AND bucket_hash=?', [window, next, namespace, bucket]);
    return next;
  });
  if (count > maximum) fail(429, 'rate_limited');
}
async function body(req, keys) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'json_required');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 2048) fail(413, 'body_too_large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_json'); }
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some((key) => !keys.includes(key))) fail(400, 'invalid_fields');
  return value;
}
/** Nicknames: 1-16 visible characters, no control characters or angle brackets. */
function displayName(value) {
  if (typeof value !== 'string') fail(400, 'invalid_display_name');
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name || [...name].length > 16 || /[\u0000-\u001f\u007f<>]/.test(name)) fail(400, 'invalid_display_name');
  return name;
}
async function identity(req, required = true) {
  const auth = req.headers.authorization || '';
  if (!auth && !required) return null;
  if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) fail(401, 'guest_session_required');
  const [[player]] = await db.execute('SELECT id, display_name FROM game_lb_players WHERE namespace=? AND token_hash=? AND expires_at>UTC_TIMESTAMP(3)', [namespace, digest(auth.slice(7))]);
  if (!player) fail(401, 'guest_session_expired');
  await rateLimit(`player:${player.id}`, 120);
  return player;
}
async function board(conn, id) {
  const [[value]] = await conn.execute('SELECT * FROM game_lb_boards WHERE namespace=? AND id=?', [namespace, id]);
  if (!value) fail(404, 'board_not_found');
  if (!['asc', 'desc'].includes(value.direction) || !value.rules_version || Number(value.min_score) < -1e9 || Number(value.max_score) > 1e9 || Number(value.min_score) > Number(value.max_score)) fail(503, 'board_configuration_invalid');
  return value;
}
/** Insert or improve a player's best row on one ranking key (desc boards: rank_value = -score). */
async function upsertBest(conn, key, playerId, score, runId) {
  const rankValue = -score;
  const [[best]] = await conn.execute('SELECT rank_value FROM game_lb_best WHERE namespace=? AND board_id=? AND player_id=? FOR UPDATE', [namespace, key, playerId]);
  if (!best) {
    await conn.execute('INSERT INTO game_lb_best (namespace,board_id,player_id,score,rank_value,achieved_at,run_id) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3),?)', [namespace, key, playerId, score, rankValue, runId]);
  } else if (rankValue < Number(best.rank_value)) {
    await conn.execute('UPDATE game_lb_best SET score=?,rank_value=?,achieved_at=UTC_TIMESTAMP(3),run_id=? WHERE namespace=? AND board_id=? AND player_id=?', [score, rankValue, runId, namespace, key, playerId]);
  }
}
/** Where a score lands among everyone else's bests on one key. */
async function standing(key, playerId, score) {
  const [[row]] = await db.execute(
    'SELECT COUNT(*) AS total, COALESCE(SUM(player_id<>? AND score>?),0) AS higher, COALESCE(SUM(player_id<>? AND score<?),0) AS beaten, MAX(CASE WHEN player_id=? THEN score END) AS best FROM game_lb_best WHERE namespace=? AND board_id=?',
    [playerId, score, playerId, score, playerId, namespace, key],
  );
  const total = Number(row.total);
  return { rank: Number(row.higher) + 1, total, beaten: Number(row.beaten), best: row.best === null ? score : Number(row.best) };
}
async function readBoard(req, url, rules) {
  const scope = url.searchParams.get('scope') || 'all';
  if (!['all', 'day'].includes(scope)) fail(400, 'invalid_scope');
  const day = url.searchParams.get('day') || utcDay();
  if (!dayPattern.test(day)) fail(400, 'invalid_day');
  const key = scope === 'day' ? dayBoard(day) : BOARD_ID;
  const limit = Number(url.searchParams.get('limit') || 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'invalid_limit');
  const player = await identity(req, false);
  const [entries] = await db.query(`SELECT b.player_id AS playerId,p.display_name AS displayName,b.score,b.achieved_at AS achievedAt FROM game_lb_best b JOIN game_lb_players p ON p.namespace=b.namespace AND p.id=b.player_id WHERE b.namespace=? AND b.board_id=? ORDER BY b.rank_value,b.achieved_at,b.player_id LIMIT ?`, [namespace, key, limit]);
  const [[count]] = await db.execute('SELECT COUNT(*) AS total FROM game_lb_best WHERE namespace=? AND board_id=?', [namespace, key]);
  let myRank = null;
  if (player) {
    const [[own]] = await db.execute('SELECT * FROM game_lb_best WHERE namespace=? AND board_id=? AND player_id=?', [namespace, key, player.id]);
    if (own) {
      const [[rank]] = await db.execute('SELECT COUNT(*)+1 AS ordinal FROM game_lb_best WHERE namespace=? AND board_id=? AND (rank_value<? OR (rank_value=? AND (achieved_at<? OR (achieved_at=? AND player_id<?))))', [namespace, key, own.rank_value, own.rank_value, own.achieved_at, own.achieved_at, player.id]);
      myRank = { rank: Number(rank.ordinal), score: Number(own.score) };
    }
  }
  return {
    namespace, boardId: BOARD_ID, scope, day: scope === 'day' ? day : null, rulesVersion: rules.rules_version, trust: 'client_reported', total: Number(count.total),
    entries: entries.map((e, i) => ({ playerId: e.playerId, displayName: e.displayName, score: Number(e.score), achievedAt: e.achievedAt, rank: i + 1, me: !!player && e.playerId === player.id })),
    myRank,
  };
}
async function handle(req, res) {
  const url = new URL(req.url, 'http://game-api');
  if (url.pathname === '/api/health' && req.method === 'GET') return send(res, 200, { status: 'ok' });
  if (!url.pathname.startsWith(`${prefix}/`)) fail(404, 'not_found');
  if (req.headers['sec-fetch-site'] === 'cross-site' && !corsAllowed(req)) fail(403, 'cross_origin_request');
  if (url.pathname === `${prefix}/health` && req.method === 'GET') {
    await assertDatabaseReady(db, namespace, backendContract);
    await db.execute('SELECT stats_json FROM game_lb_runs LIMIT 0');
    return send(res, 200, { status: 'ok', namespace, readonly, protocolVersion: PROTOCOL_VERSION, schemaVersion: SCHEMA_VERSION });
  }
  await assertDatabaseEnvironment(db, namespace);
  if (readonly && req.method !== 'GET') fail(403, 'leaderboard_read_only');
  if (req.method === 'POST' && url.pathname === `${prefix}/guests`) {
    await rateLimit('global:guests', 300);
    const data = await body(req, ['displayName']);
    const name = displayName(data.displayName);
    const token = randomBytes(32).toString('base64url');
    const playerId = randomUUID();
    await db.execute('INSERT INTO game_lb_players (namespace,id,display_name,token_hash,expires_at) VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 DAY))', [namespace, playerId, name, digest(token)]);
    return send(res, 201, { playerId, token, displayName: name, expiresInSeconds: 2592000 });
  }
  if (req.method === 'PUT' && url.pathname === `${prefix}/players/me`) {
    const player = await identity(req);
    const data = await body(req, ['displayName']);
    const name = displayName(data.displayName);
    // Activity keeps the guest identity alive.
    await db.execute('UPDATE game_lb_players SET display_name=?, expires_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 DAY) WHERE namespace=? AND id=?', [name, namespace, player.id]);
    return send(res, 200, { playerId: player.id, displayName: name });
  }
  const route = url.pathname.slice(prefix.length).split('/').filter(Boolean);
  if (route[0] === 'boards' && idPattern.test(route[1] || '')) {
    const boardId = route[1];
    if (req.method === 'GET' && route.length === 2) {
      const rules = await board(db, boardId);
      return send(res, 200, await readBoard(req, url, rules));
    }
    if (req.method === 'POST' && route.length === 3 && route[2] === 'runs') {
      const player = await identity(req);
      const data = await body(req, ['releaseSha', 'protocolVersion', 'rulesVersion']);
      if (data.releaseSha !== undefined && (typeof data.releaseSha !== 'string' || !/^[a-f0-9]{7,64}$/.test(data.releaseSha))) fail(400, 'invalid_release_sha');
      const rules = await board(db, boardId);
      if (!rules.open) fail(409, 'board_closed');
      assertClientRules(data, rules);
      const runId = randomUUID();
      await db.execute('INSERT INTO game_lb_runs (namespace,id,player_id,board_id,issued_at,expires_at,release_sha,rules_version,protocol_version) VALUES (?,?,?,?,UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 MINUTE),?,?,?)', [namespace, runId, player.id, boardId, data.releaseSha ?? null, rules.rules_version, PROTOCOL_VERSION]);
      return send(res, 201, { runId, expiresInSeconds: 1800, rulesVersion: rules.rules_version, protocolVersion: PROTOCOL_VERSION });
    }
  }
  if (req.method === 'PUT' && route.length === 2 && route[0] === 'runs' && uuidPattern.test(route[1])) {
    const player = await identity(req);
    const raw = await body(req, ['score', 'durationMs', 'stats']);
    const data = validateDriftRun(raw);
    const submissionHash = digest(JSON.stringify([data.score, data.durationMs, data.stats]));
    const receipt = await db.transaction(async (conn) => {
      // A player-level lock serializes simultaneous runs before any best row exists.
      await conn.execute('SELECT id FROM game_lb_players WHERE namespace=? AND id=? FOR UPDATE', [namespace, player.id]);
      const [[run]] = await conn.execute('SELECT *, DATE(issued_at) AS issued_day, expires_at<UTC_TIMESTAMP(3) AS expired, TIMESTAMPDIFF(MICROSECOND,issued_at,UTC_TIMESTAMP(3))/1000 AS elapsed FROM game_lb_runs WHERE namespace=? AND id=? AND player_id=? FOR UPDATE', [namespace, route[1], player.id]);
      const previous = previousSubmission(run, namespace, player.id, submissionHash);
      const day = String(run.issued_day).slice(0, 10);
      if (previous) return { ...previous, day };
      const rules = await board(conn, run.board_id);
      if (!rules.open) fail(409, 'board_closed');
      assertRunRules(run, rules);
      const elapsed = Number(run.elapsed);
      if (elapsed < MIN_SERVER_ELAPSED_MS) fail(422, 'run_too_fast');
      if (data.score < Number(rules.min_score) || data.score > Number(rules.max_score) || data.durationMs < Number(rules.min_duration_ms) || data.durationMs > Number(rules.max_duration_ms) || data.durationMs > elapsed + 5000) fail(422, 'score_outside_rules');
      await upsertBest(conn, run.board_id, player.id, data.score, run.id);
      await upsertBest(conn, dayBoard(day), player.id, data.score, run.id);
      await conn.execute('UPDATE game_lb_runs SET score=?,duration_ms=?,submission_hash=?,submitted_at=UTC_TIMESTAMP(3),stats_json=? WHERE namespace=? AND id=?', [data.score, data.durationMs, submissionHash, JSON.stringify(data.stats), namespace, run.id]);
      return { runId: run.id, score: data.score, accepted: true, trust: 'client_reported', day };
    });
    const [all, today] = await Promise.all([standing(BOARD_ID, player.id, receipt.score), standing(dayBoard(receipt.day), player.id, receipt.score)]);
    return send(res, 200, { ...receipt, all, today });
  }
  fail(404, 'not_found');
}
const server = http.createServer((req, res) => {
  const allowed = applyCors(req, res);
  if (req.method === 'OPTIONS') {
    if (!allowed) return send(res, 403, { error: 'cross_origin_request' });
    res.writeHead(204);
    return res.end();
  }
  db.run(req, res, () => handle(req, res)).catch((error) => {
    if (res.destroyed || res.writableEnded) return;
    send(res, error.status || 503, { error: error.code && error.status ? error.code : 'leaderboard_unavailable' });
    // Stop a slow unfinished upload after returning the bounded failure response.
    if (!req.complete) res.once('finish', () => req.destroy());
  });
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(Number(process.env.PORT || 8080), process.env.HOST || '0.0.0.0', () => {
  const address = server.address();
  if (typeof address === 'object') process.send?.({ type: 'ready', port: address.port });
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => pool.end().finally(() => process.exit(0))));
