#!/usr/bin/env node
/**
 * Every tool must return structured content that matches its declared schema.
 *
 * Why this test is not optional
 * -----------------------------
 * Each tool declares an `outputSchema`. The SDK reacts to that by THROWING on
 * any non-error result that omits `structuredContent`, and by validating the
 * content it does get. Three of this server's return paths are deliberately
 * non-error — a tier wall, a missing key, an empty result — so declaring output
 * schemas turned all three into potential 500s across all twelve tools at once.
 *
 * So this drives every tool twice: once with no key (the guard's early return)
 * and once against a stub upstream (the success path). A schema violation
 * surfaces as a JSON-RPC error, which is exactly what this asserts against.
 *
 * Run: node test/tools-output.mjs        (no credentials, no network)
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const PORT = 8127;
const UPSTREAM_PORT = 8128;
const URL = `http://127.0.0.1:${PORT}/mcp`;
const fail = (m) => { throw new Error(m); };
const die = (m) => { console.error('FAIL:', m); process.exit(1); };

/** Paths the upstream was asked for — printed on failure so a 404 is obvious. */
const asked = [];

const MATCH = {
  id: 101,
  tournament: 'Test Open',
  round: 'QF',
  status: 'live',
  surface: 'hard',
  indoor: false,
  winner: null,
  players: { p1: { id: 1, name: 'Player One' }, p2: { id: 2, name: 'Player Two' } },
  score: { sets: [1, 0], server: 1, is_tiebreak: false, win_probability_p1: 0.61, games: [[6, 4], [3, 2]] },
};
const PLAYER = {
  id: 1, name: 'Player One', country: 'ESP', ranking: 3, ranking_points: 7000,
  ranking_movement: 'up', hand: 'R', birthday: '2003-05-05', tour: 'ATP',
};
const FIXTURE = {
  event_date: '2026-07-23T12:00:00Z', tournament: 'Test Open', round: 'SF',
  player1_name: 'Player One', player2_name: 'Player Two',
};
const MARKET = {
  question: 'Who wins?', status: 'open', volume: 1000, liquidity: 500,
  prices: [{ side: 1, mid: 0.6, bid: 0.59, ask: 0.61, timestamp: '2026-07-22T00:00:00Z' }],
};
const ANALYSIS = {
  profile: { win_probability_p1: 0.61, expected_closeness: 0.4, volatility_rating: 'medium', key_factors: ['serve'] },
  thesis: { pick_side: 1, confidence: 0.7, state: 'active', reasoning: 'Better on hard courts.' },
};

const page = (row) => ({ data: [row], meta: { limit: 1, offset: 0, count: 1 } });

/** Answer whatever the client asks for, shaped by what the path looks like. */
const upstream = createServer((req, res) => {
  const url = req.url ?? '';
  asked.push(url);
  const send = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const path = url.split('?')[0];
  if (path.includes('/health')) return send({ status: 'ok', version: 'v1' });
  if (path.includes('/events')) return send(page({ timestamp: '2026-07-22T00:00:00Z', type: 'break', player: 1 }));
  if (path.includes('/analysis')) return send(ANALYSIS);
  if (path.includes('/markets') || path.includes('/prices')) return send(MARKET);
  if (path.includes('/score')) return send(MATCH.score);
  if (path.includes('/fixtures')) return send(page(FIXTURE));
  // A trailing numeric segment means one item; otherwise a collection.
  const single = /\/\d+$/.test(path);
  if (path.includes('/players')) return send(single ? PLAYER : page(PLAYER));
  if (path.includes('/matches')) return send(single ? MATCH : page(MATCH));
  send(page(MATCH));
});

for (const p of [PORT, UPSTREAM_PORT]) {
  try {
    const stray = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(800) });
    if (stray.ok) die(`port ${p} is already serving — kill the stray process before running this test`);
  } catch { /* nothing listening, which is what we want */ }
}

await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

const child = spawn('node', ['dist/http.js'], {
  env: { ...process.env, PORT: String(PORT), LIVETENNISAPI_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}` },
  stdio: ['ignore', 'inherit', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });

const rpc = async (body, headers = {}) => {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const line = raw.startsWith('event:') || raw.startsWith('data:')
    ? raw.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim()
    : raw;
  return line ? JSON.parse(line) : null;
};

/** Plausible arguments for every tool, so none is skipped for lack of input. */
const ARGS = {
  get_live_matches: { limit: 2 },
  get_upcoming_matches: { limit: 2 },
  get_match: { match_id: 101 },
  get_match_score: { match_id: 101 },
  search_players: { query: 'player', limit: 2 },
  get_player: { player_id: 1 },
  get_fixtures: { limit: 2 },
  get_recent_results: { limit: 2 },
  get_match_events: { match_id: 101, limit: 2 },
  get_match_odds: { match_id: 101, limit: 2 },
  get_match_analysis: { match_id: 101 },
  check_api_status: {},
};

const call = (name, headers) =>
  rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: ARGS[name] ?? {} } }, headers);

async function main() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const tools = list?.result?.tools ?? [];
  if (tools.length !== 12) fail(`expected 12 tools, got ${tools.length}`);

  // 1. Metadata every tool must carry. These are what a directory scores, and
  //    a missing one is invisible until something else reports a low number.
  for (const t of tools) {
    if (!t.description) fail(`${t.name} has no description`);
    if (!t.outputSchema) fail(`${t.name} declares no outputSchema`);
    if (!t.annotations) fail(`${t.name} has no annotations`);
    if (t.annotations.readOnlyHint !== true) fail(`${t.name} is not marked readOnlyHint — every tool here is a GET`);
    if (!t.title && !t.annotations.title) fail(`${t.name} has no title`);
    if (!ARGS[t.name]) fail(`${t.name} is not covered by this test's ARGS — add it`);
    // Every declared parameter needs a description, or a client cannot prompt for it.
    for (const [param, spec] of Object.entries(t.inputSchema?.properties ?? {})) {
      if (!spec.description) fail(`${t.name}.${param} has no description`);
    }
  }

  // 2. THE PATH THAT BREAKS. No key: guard returns early, and that early return
  //    must still carry structured content or the SDK rejects the whole call.
  for (const t of tools) {
    const r = await call(t.name);
    if (r?.error) fail(`${t.name} (no key) returned a JSON-RPC error: ${JSON.stringify(r.error).slice(0, 200)}`);
    if (!r?.result?.structuredContent) fail(`${t.name} (no key) returned no structuredContent`);
    const sc = r.result.structuredContent;
    if (typeof sc.message !== 'string') fail(`${t.name} (no key) has no message field`);
    if (t.name === 'check_api_status') {
      // The one tool that legitimately WORKS without a key — diagnosing "why is
      // everything else refusing data" is precisely its job, so it reports the
      // API as reachable and says the key is absent rather than failing.
      if (sc.ok !== true) fail('check_api_status should still succeed without a key — it is the diagnostic tool');
      if (sc.has_key !== false) fail('check_api_status (no key) should report has_key:false');
      if (sc.tier !== null) fail(`check_api_status (no key) should report tier:null, got ${JSON.stringify(sc.tier)}`);
    } else if (sc.ok !== false) {
      fail(`${t.name} (no key) should report ok:false`);
    }
  }

  // 3. The success path, against the stub. Validation failures surface here as
  //    JSON-RPC errors, because the SDK checks structuredContent against the schema.
  const withKey = { authorization: 'Bearer twjp_test_key' };
  const noData = [];
  for (const t of tools) {
    const r = await call(t.name, withKey);
    if (r?.error) fail(`${t.name} (with key) returned a JSON-RPC error: ${JSON.stringify(r.error).slice(0, 300)}`);
    const sc = r?.result?.structuredContent;
    if (!sc) fail(`${t.name} (with key) returned no structuredContent`);
    if (typeof sc.ok !== 'boolean') fail(`${t.name} (with key) has no ok field`);
    if (typeof sc.message !== 'string') fail(`${t.name} (with key) has no message field`);
    // The text half must not silently diverge from the structured half.
    const textPart = r.result.content?.find((c) => c.type === 'text')?.text;
    if (!textPart) fail(`${t.name} returned no text content`);
    if (sc.ok && textPart !== sc.message) fail(`${t.name}: text content and structuredContent.message disagree`);
    // Track tools the stub could not feed, so a silently-empty suite is visible
    // rather than passing as if it had exercised the real path.
    if (sc.ok !== true) noData.push(t.name);
  }

  if (noData.length > tools.length / 2) {
    fail(`the stub fed only ${tools.length - noData.length}/${tools.length} tools real data — `
       + `this test is not proving much. Unfed: ${noData.join(', ')}. Paths asked: ${[...new Set(asked)].join(' ')}`);
  }

  console.log(`OK - 12 tools · outputSchema + annotations + param descriptions · `
    + `structuredContent valid on both the no-key and success paths`
    + (noData.length ? ` · stub could not feed: ${noData.join(', ')}` : ''));
}

main()
  .then(() => shutdown(0))
  .catch((e) => {
    console.error('FAIL:', e.message);
    console.error('--- upstream paths asked ---\n ', [...new Set(asked)].join('\n  '));
    console.error('--- server stderr ---\n', stderr.slice(0, 2000));
    shutdown(1);
  });

function shutdown(code) {
  child.kill('SIGKILL');
  upstream.closeAllConnections?.();
  upstream.close();
  process.exit(code);
}
