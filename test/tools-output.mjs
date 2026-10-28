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
  scheduled_time: '2026-10-22T11:00:00Z',
  surface: 'hard',
  indoor: false,
  winner: null,
  event_status: 'Interrupted',
  event_status_updated_at: '2026-08-19T09:15:00Z',
  has_analysis: true,
  has_market: false,
  players: { p1: { id: 1, name: 'Player One' }, p2: { id: 2, name: 'Player Two' } },
  // The score object as the API serves it today: beside the keys the tools
  // name it carries the accept counter, the two clocks and the model twin
  // (score first, 2026-10-23). The tools must pass through a richer object
  // than they declare.
  score: {
    sets: [1, 0],
    server: 1,
    is_tiebreak: false,
    win_probability_p1: 0.61,
    danger: 0.2,
    win_probability_p1_model: 0.58,
    win_probability_meta: { model_version: 'markov-population-2026-08-23', anchor_effective: true },
    sequence: 104,
    accepted_at: '2026-10-22T11:30:00.000Z',
    received_at: '2026-10-22T11:29:59.900Z',
    games: [[6, 4], [3, 2]],
  },
};
// A row from a server that predates has_analysis / has_market (2026-09-02):
// both keys absent. The mapper must pass null through and the summary must
// not invent a coverage line.
const OLDER_MATCH = {
  id: 102,
  tournament: 'Test Open',
  round: 'QF',
  status: 'live',
  winner: null,
  players: { p1: { id: 3, name: 'Player Three' }, p2: { id: 4, name: 'Player Four' } },
  score: { sets: [0, 0], server: 2, is_tiebreak: false, games: [[2, 3]] },
};
// A match that has not started: the summary must carry its start time, which
// is the one fact a "who plays next" question is asking for.
const UPCOMING_MATCH = {
  id: 103,
  tournament: 'Test Open',
  round: 'SF',
  status: 'upcoming',
  scheduled_time: '2026-10-23T13:30:00Z',
  winner: null,
  players: { p1: { id: 5, name: 'Player Five' }, p2: { id: 6, name: 'Player Six' } },
  score: null,
};
const PLAYER = {
  id: 1, name: 'Player One', country: 'ESP', ranking: 3, ranking_points: 7000,
  ranking_movement: 'up', hand: 'R', birthday: '2003-05-05', tour: 'ATP',
};
const PLAYER_STATS = {
  player: { id: 1, name: 'Player One' },
  window: { from: '2025-10-22T00:00:00Z', to: '2026-10-22T00:00:00Z' },
  filters: { surface: null, level: null, last: 20 },
  records: {
    overall: { matches: 10, wins: 7, losses: 3, win_pct: 70.0 },
    last_12_months: { matches: 10, wins: 7, losses: 3, win_pct: 70.0 },
    by_surface: { clay: { matches: 4, wins: 3, losses: 1, win_pct: 75.0 } },
    by_venue: { outdoor: { matches: 10, wins: 7, losses: 3, win_pct: 70.0 } },
    by_level: { atp: { matches: 10, wins: 7, losses: 3, win_pct: 70.0 } },
    by_season: { 2026: { matches: 10, wins: 7, losses: 3, win_pct: 70.0 } },
    sets: { sample: { matches: 9 }, tiebreaks: { played: 0, won: 0, lost: 0, win_pct: null } },
    withdrawals: { retired: { given: 0, received: 1 } },
    excluded: { not_singles: 0 },
    recent: [{
      match_id: 101, date: '2026-10-20', tournament: 'Test Open', round: 'QF', surface: 'clay',
      opponent: { id: 2, name: 'Player Two' }, won: true, outcome: 'completed',
      score: { sets: [2, 1], games: [[6, 3, 6], [4, 6, 2]] },
    }, {
      // The API sends opponent null when the match row holds no opponent id.
      match_id: 100, date: '2026-10-18', tournament: 'Test Open', round: 'R16', surface: 'clay',
      opponent: null, won: true, outcome: 'walkover', score: null,
    }, {
      // The spec lets the two per-side game lists differ in length (a retirement
      // mid-set, or a set only one side has a count for).
      match_id: 99, date: '2026-10-16', tournament: 'Test Open', round: 'R32', surface: 'clay',
      opponent: { id: 3, name: 'Player Three' }, won: false, outcome: 'retired',
      score: { sets: [0, 2], games: [[6], [4, 6, 5]] },
    }, {
      match_id: 98, date: '2026-10-14', tournament: 'Test Open', round: 'R64', surface: 'clay',
      opponent: { id: 4, name: 'Player Four' }, won: false, outcome: 'completed',
      score: { sets: [0, 2], games: [[], [6, 4]] },
    }, {
      // An inner null means that game count is unknown, not 0.
      match_id: 97, date: '2026-10-12', tournament: 'Test Open', round: 'Q2', surface: 'clay',
      opponent: { id: 5, name: 'Player Five' }, won: true, outcome: 'completed',
      score: { sets: [2, 1], games: [[6, null, 7], [4, 6, 5]] },
    }],
  },
  serve_return: { matches: 10, matches_with_stats: 8, serve: { aces: { total: 40, matches: 8, per_match: 5.0 } } },
  meta: { generated_at: '2026-10-22T00:00:00Z' },
};
const FIXTURE = {
  event_date: '2026-07-23', start_time: '2026-07-23T12:00:00Z', tournament: 'Test Open', round: 'SF',
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
const TOURNAMENT = {
  id: 'atp-test-open', name: 'Test Open', tour: 'atp', surface: 'hard', indoor: false,
  city: 'Testville', country: 'GB', category: 'atp_250',
};
const ARCHIVE_SIDE = {
  name: 'Old Player', country: 'SWE', rank: 1, seed: 1, player_id: 100437,
  hand: 'R', height_cm: 180, age: 24.1, entry: null,
};
const ARCHIVE_MATCH = {
  id: 555, source_id: '1980-540-1', tour: 'atp', level: 'G', tournament: 'Old Slam',
  surface: 'grass', event_date: '1980-06-23', round: 'F', best_of: 5, minutes: 235,
  winner: ARCHIVE_SIDE, loser: { ...ARCHIVE_SIDE, name: 'Other Player', rank: 2, seed: 2 },
  score: '1-6 7-5 6-3 6-7 8-6', outcome: 'completed',
  stats: { winner: { aces: 9, double_faults: 2 }, loser: { aces: 11, double_faults: 4 } },
};
const ARCHIVE_BIO = {
  id: 100437, tour: 'atp', name: 'Old Player', hand: 'R', dob: '1956-06-06',
  country: 'SWE', height_cm: 180, career_high_rank: 1, career_high_date: '1977-08-23',
};
const CAREER = {
  player: { name: 'Old Player' },
  span: { first: '1973-01-01', last: '1983-07-25' },
  record: { wins: 654, losses: 140, titles: 66, by_surface: { grass: { wins: 100, losses: 20 } }, by_level: { G: { wins: 141, losses: 16 } } },
  by_year: [{ year: 1980, wins: 70, losses: 6 }],
  serve: { matches_with_stats: 0, aces: 0, double_faults: 0, serve_points: 0, first_in: 0, first_won: 0, second_won: 0, serve_games: 0, bp_saved: 0, bp_faced: 0, first_in_pct: null, first_won_pct: null, second_won_pct: null, bp_saved_pct: null, aces_per_match: null },
};
const RANKING = {
  player_id: 1, player_name: 'Player One', system: 'atp', tour: 'atp', rank: 1, points: 9000,
  previous_rank: 2, rank_movement: null, rating: null, effective_date: '2026-08-03', observed_at: null,
};
const STATS_SIDE = {
  measured: { aces: 7, double_faults: 2, first_serves_in: 30, winners_total: 12, unforced_errors_total: 9 },
  service_games_played: 8, service_games_won: 7, hold_pct: 88,
  return_games_played: 7, return_games_won: 2, break_pct: 29,
  break_points_faced: 4, break_points_saved: 3, break_points_saved_pct: 75,
  break_points_played: 5, break_points_converted: 2, break_points_converted_pct: 40,
  service_points_played: 50, service_points_won: 35, service_points_won_pct: 70,
  return_points_played: 48, return_points_won: 20, return_points_won_pct: 42,
  points_played: 98, points_won: 55,
};
const STATISTICS = {
  match_id: 101, coverage: 'live', as_of: '2026-08-07T00:00:00Z', age_seconds: 4,
  games_counted: 15, tiebreak_games_excluded: 0, inconsistent_games_excluded: 0, sets_covered: [1, 2],
  freshness: { derived: { coverage: 'live', age_seconds: 4 }, measured: { coverage: 'live', age_seconds: 20 } },
  players: { p1: STATS_SIDE, p2: { ...STATS_SIDE, hold_pct: 71 } },
};
const CHARTING_PLAYER = {
  player: { name: 'Old Player', gender: 'men' }, matches_charted: 42, coverage: 'curated',
  families: { serve_direction: { deuce_wide: 120, deuce_body: 40, deuce_t: 90 } },
};
const CHARTING_MATCH = {
  charting_match_id: 777, mcp_id: '19800623-M-Old_Slam-F-Old_Player-Other_Player', gender: 'M',
  players: { p1: { name: 'Old Player' }, p2: { name: 'Other Player' } },
  families: { serve_direction: { p1: [{ row: 'Total', deuce_wide: 12 }] } },
};
const H2H = {
  players: { p1: { name: 'Old Player' }, p2: { name: 'Other Player' } },
  totals: { p1_wins: 7, p2_wins: 7, meetings: 14, undecided: 0 },
  by_surface: { grass: { p1: 2, p2: 1 }, unknown: { p1: 0, p2: 0 } },
  meetings: [
    { era: 'archive', date: '1980-06-23', tournament: 'Old Slam', level: 'G', round: 'F', surface: 'grass', score: '1-6 7-5 6-3 6-7 8-6', outcome: 'completed', winner: 1, archive_match_id: 555 },
  ],
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
  // The rankings/statistics/charting matchers must sit ABOVE the generic
  // /players and /matches matchers — their paths contain those substrings.
  if (path.includes('/rankings')) {
    return send({
      data: [RANKING],
      meta: { limit: 20, offset: 0, count: 1, coverage: { as_of: null, players_requested: 1, players_resolved: 1, systems_resolved: ['atp'], oldest_available: { atp: '1973-08-23' } } },
    });
  }
  if (path.includes('/statistics')) return send(STATISTICS);
  if (path === '/players/999/stats') {
    // A doubles-team id: the API refuses it with 400 doubles_not_supported.
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'doubles_not_supported', detail: 'this id is a doubles team' }));
  }
  // The documented refusals of /players/{id}/stats, each carrying something
  // the caller needs: a successor id, an explanation, the accepted values, a
  // signpost. The tool must relay them, not reduce them to the status word.
  const refuse = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (path === '/players/410/stats') {
    return refuse(410, { error: 'merged', merged_into: 42, merged_at: '2026-01-01T00:00:00Z', detail: 'Player 410 was merged into player 42.' });
  }
  if (path === '/players/411/stats') {
    return refuse(410, { error: 'merged', merged_into: null, merged_at: '2026-01-01T00:00:00Z', detail: 'Player 411 was retired with no successor.' });
  }
  if (path === '/players/400/stats') {
    return refuse(400, { error: 'bad_date', detail: 'from must be YYYY-MM-DD or an ISO-8601 instant' });
  }
  if (path === '/players/401/stats') {
    return refuse(400, { error: 'bad_level', detail: 'unknown level', allowed: ['atp', 'wta', 'challenger', 'itf', 'juniors'] });
  }
  if (path === '/players/404/stats') {
    return refuse(404, { error: 'not_found', detail: 'This id is a corpus person id.', see: '/api/public/v1/history/archive/players?id=404' });
  }
  if (/\/players\/\d+\/stats$/.test(path)) return send(PLAYER_STATS);
  if (path.includes('/charting/players')) return send(CHARTING_PLAYER);
  if (path.includes('/charting/matches')) return send(CHARTING_MATCH);
  if (path.includes('/events')) return send(page({ timestamp: '2026-07-22T00:00:00Z', type: 'break', player: 1 }));
  if (path.includes('/analysis')) return send(ANALYSIS);
  if (path.includes('/markets') || path.includes('/prices')) return send(MARKET);
  if (path.includes('/score')) return send(MATCH.score);
  if (path.includes('/fixtures')) return send(page(FIXTURE));
  // A trailing numeric segment means one item; otherwise a collection.
  const single = /\/\d+$/.test(path);
  // The archive and h2h routes must sit ABOVE the generic /players and
  // /matches matchers, or /history/archive/players lands on the roster stub.
  if (path.includes('/archive/players')) return send(page(ARCHIVE_BIO));
  if (path.includes('/archive/career')) return send(CAREER);
  if (path.includes('/archive/matches')) return send(single ? ARCHIVE_MATCH : page(ARCHIVE_MATCH));
  if (path.includes('/h2h')) return send(H2H);
  if (path.includes('/tournaments')) return send(path.includes('/tournaments/') ? TOURNAMENT : page(TOURNAMENT));
  if (path.includes('/players')) return send(single ? PLAYER : page(PLAYER));
  if (path.includes('/matches')) {
    return send(single ? MATCH : { data: [MATCH, OLDER_MATCH, UPCOMING_MATCH], meta: { limit: 3, offset: 0, count: 3 } });
  }
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
  player_stats: { player_id: 1, from: '2025-10-22', surface: 'clay', last: 5 },
  get_fixtures: { limit: 2 },
  get_recent_results: { limit: 2 },
  search_tournaments: { query: 'test', limit: 2 },
  get_tournament: { tournament_id: 'atp-test-open' },
  search_archive_matches: { player_name: 'old player', round: 'F', limit: 2 },
  get_archive_match: { archive_match_id: 555 },
  search_archive_players: { query: 'old player', limit: 2 },
  get_archive_career: { name: 'old player' },
  get_h2h: { player1: 'old player', player2: 'other player' },
  get_match_events: { match_id: 101, limit: 2 },
  get_match_odds: { match_id: 101, limit: 2 },
  get_rankings: { system: 'atp', limit: 2 },
  get_player_rankings: { player_ids: [1] },
  get_match_statistics: { match_id: 101 },
  get_charting_player: { name: 'old player' },
  get_charting_match: { charting_match_id: 777 },
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
  if (tools.length !== 25) fail(`expected 25 tools, got ${tools.length}`);

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

  // 4. Spot-check the match mapper against the stub's known values, so "the
  //    schema was satisfied" cannot pass on nulls all the way down.
  //    has_analysis / has_market (added 2026-09-02): present-true and
  //    present-false reach the caller as booleans plus one summary line each;
  //    absent (older server) is null with no coverage line invented.
  const live = (await call('get_live_matches', withKey))?.result?.structuredContent;
  const m = live?.matches?.[0];
  if (m?.id !== 101) fail(`expected match id 101, got ${JSON.stringify(m)}`);
  if (m.has_analysis !== true) fail(`has_analysis not mapped: ${JSON.stringify(m.has_analysis)}`);
  if (m.has_market !== false) fail(`has_market not mapped: ${JSON.stringify(m.has_market)}`);
  if (!live.message.includes('Analysis: available')) fail(`summary lacks the analysis line:\n${live.message}`);
  if (!live.message.includes('Market: none')) fail(`summary lacks the market line:\n${live.message}`);
  const older = live.matches[1];
  if (older?.id !== 102) fail(`expected the older-server row second, got ${JSON.stringify(older)}`);
  if (older.has_analysis !== null) fail(`absent has_analysis should map to null: ${JSON.stringify(older.has_analysis)}`);
  if (older.has_market !== null) fail(`absent has_market should map to null: ${JSON.stringify(older.has_market)}`);
  const olderSummary = live.message.slice(live.message.indexOf('[102]'), live.message.indexOf('[103]'));
  if (!olderSummary.includes('Player Three')) fail('older row not summarised');
  if (/Analysis:|Market:/.test(olderSummary)) fail(`summary invented coverage for the older row:\n${olderSummary}`);

  // scheduled_time reaches the structured row on every match, and the prose
  // names it for a match that has not started (livetennisapi-ai 1.2.1 does both).
  if (m.scheduled_time !== '2026-10-22T11:00:00Z') fail(`scheduled_time not mapped: ${JSON.stringify(m.scheduled_time)}`);
  if (older.scheduled_time !== null) fail(`absent scheduled_time should map to null: ${JSON.stringify(older.scheduled_time)}`);
  const upcoming = (await call('get_upcoming_matches', withKey))?.result?.structuredContent;
  const soon = upcoming?.matches?.[2];
  if (soon?.id !== 103 || soon.scheduled_time !== '2026-10-23T13:30:00Z') fail(`upcoming row lost its start: ${JSON.stringify(soon)}`);
  if (!upcoming.message.includes('Starts: 2026-10-23T13:30:00Z')) fail(`upcoming summary lacks the start time:\n${upcoming.message}`);
  const liveSummary = live.message.slice(live.message.indexOf('[101]'), live.message.indexOf('[102]'));
  if (liveSummary.includes('Starts:')) fail(`a live match must not carry a Starts line:\n${liveSummary}`);

  // start_time reaches the fixture row and leads its prose line.
  const fx = (await call('get_fixtures', withKey))?.result?.structuredContent;
  const f0 = fx?.fixtures?.[0];
  if (f0?.event_date !== '2026-07-23' || f0.start_time !== '2026-07-23T12:00:00Z') fail(`fixture times not mapped: ${JSON.stringify(f0)}`);
  if (!fx.message.startsWith('2026-07-23T12:00:00Z')) fail(`fixture prose does not lead with start_time:\n${fx.message}`);

  // player_stats: the path and query reach upstream, and the score is turned to the player.
  const ps = (await call('player_stats', withKey))?.result?.structuredContent;
  if (ps?.ok !== true) fail(`player_stats did not succeed: ${JSON.stringify(ps)}`);
  if (ps.overall?.win_pct !== 70) fail(`player_stats overall not mapped: ${JSON.stringify(ps.overall)}`);
  if (ps.recent?.[0]?.score !== '6-4 3-6 6-2') fail(`player_stats score not formatted: ${JSON.stringify(ps.recent)}`);
  if (ps.serve_return?.matches_with_stats !== 8) fail('player_stats serve_return not passed through');
  const psAsked = asked.find((u) => u.startsWith('/players/1/stats'));
  if (!psAsked || !psAsked.includes('surface=clay') || !psAsked.includes('last=5') || !psAsked.includes('from=2025-10-22')) {
    fail(`player_stats asked upstream for ${psAsked}`);
  }
  const nullOpp = ps.recent?.[1];
  if (nullOpp?.match_id !== 100 || nullOpp.opponent !== null || nullOpp.opponent_id !== null) {
    fail(`player_stats null opponent not mapped to nulls: ${JSON.stringify(nullOpp)}`);
  }
  // Asymmetric per-side game lists keep every set, with ? for a count the API
  // does not hold. 1.6.2 walked the player's own list only and dropped the rest.
  const wantScores = { 99: '6-4 ?-6 ?-5', 98: '?-6 ?-4', 97: '6-4 ?-6 7-5' };
  for (const [id, want] of Object.entries(wantScores)) {
    const row = ps.recent.find((m) => m.match_id === Number(id));
    if (row?.score !== want) fail(`player_stats score for match ${id}: got ${JSON.stringify(row?.score)}, want ${JSON.stringify(want)}`);
    if (!ps.message.includes(` ${want}`)) fail(`player_stats prose lost the score ${want}:\n${ps.message}`);
  }

  // player_stats on a doubles-team id: a refusal with a remedy, so ok:false.
  const dbl = await rpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'player_stats', arguments: { player_id: 999 } } },
    withKey,
  );
  if (dbl?.error) fail(`player_stats (doubles id) returned a JSON-RPC error: ${JSON.stringify(dbl.error)}`);
  const dblSc = dbl?.result?.structuredContent;
  if (dblSc?.ok !== false || !/doubles team/.test(dblSc.message ?? '')) {
    fail(`player_stats (doubles id) should be ok:false with the remedy: ${JSON.stringify(dblSc)}`);
  }

  // The documented refusals: each is ok:false (a refusal with a remedy, not a
  // fault) and keeps what the API said, so the model can act on it.
  const refusal = async (player_id, extra = {}) => {
    const r = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'player_stats', arguments: { player_id, ...extra } } },
      withKey,
    );
    if (r?.error) fail(`player_stats (${player_id}) returned a JSON-RPC error: ${JSON.stringify(r.error)}`);
    if (r?.result?.isError) fail(`player_stats (${player_id}) was marked isError; a documented refusal is ok:false`);
    const sc = r?.result?.structuredContent;
    if (sc?.ok !== false || typeof sc.message !== 'string') fail(`player_stats (${player_id}) should be ok:false: ${JSON.stringify(sc)}`);
    return sc.message;
  };
  const merged = await refusal(410);
  if (!/merged into id 42/.test(merged) || !merged.includes('2026-01-01T00:00:00Z') || !merged.includes('Player 410 was merged')) {
    fail(`410 merged lost the successor id, the date or the detail: ${merged}`);
  }
  const retired = await refusal(411);
  if (!/retired with no successor/.test(retired) || !retired.includes('Player 411 was retired')) fail(`410 retired lost its detail: ${retired}`);
  const badDate = await refusal(400, { from: 'yesterday' });
  if (!badDate.includes('bad_date') || !badDate.includes('from must be YYYY-MM-DD')) fail(`400 bad_date lost its detail: ${badDate}`);
  const badLevel = await refusal(401);
  if (!badLevel.includes('bad_level') || !badLevel.includes('atp, wta, challenger, itf, juniors')) fail(`400 lost its allowed values: ${badLevel}`);
  const signpost = await refusal(404);
  if (!signpost.includes('corpus person id') || !signpost.includes('/history/archive/players?id=404')) fail(`404 lost its signpost: ${signpost}`);

  if (noData.length > tools.length / 2) {
    fail(`the stub fed only ${tools.length - noData.length}/${tools.length} tools real data — `
       + `this test is not proving much. Unfed: ${noData.join(', ')}. Paths asked: ${[...new Set(asked)].join(' ')}`);
  }

  console.log(`OK - 25 tools · outputSchema + annotations + param descriptions · `
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
