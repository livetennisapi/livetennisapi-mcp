#!/usr/bin/env node
/**
 * The rate limiter must protect the process WITHOUT letting one caller starve
 * another.
 *
 * The failure this guards against is specific to how we deploy. The server
 * listens on loopback and is reached through a Cloudflare tunnel, so every
 * request arrives from 127.0.0.1. A limiter keyed naively on the socket address
 * therefore puts EVERY user in one shared bucket, and the first busy client
 * locks out the whole world. That bug is invisible locally — one caller looks
 * perfectly fine — so it needs a test with two callers in it.
 *
 * Run: node test/http-ratelimit.mjs        (no credentials, no network)
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const PORT = 8125;
const UPSTREAM_PORT = 8126;
const URL = `http://127.0.0.1:${PORT}/mcp`;
// Throws rather than exiting, so failure unwinds into main()'s catch and runs
// shutdown() — an exit() here would strand the spawned server holding the test
// port, and the NEXT run would then silently measure that stale process.
const fail = (m) => { throw new Error(m); };
/** Bail before the server is spawned, where there is nothing to clean up. */
const die = (m) => { console.error('FAIL:', m); process.exit(1); };

// Driven down from the 60/300 production defaults so the limiter can be pushed
// to exhaustion in a few dozen requests. The server reads these from the same
// env vars, so the test never has to guess what the running limits are.
const ANON_LIMIT = 10;
const KEYED_LIMIT = 30;

// Upstream is never reached (tools/list is served locally) but the server needs
// somewhere safe to point in case anything does call out.
const upstream = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
});

for (const p of [PORT, UPSTREAM_PORT]) {
  try {
    const stray = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(800) });
    if (stray.ok) die(`port ${p} is already serving — kill the stray process before running this test`);
  } catch { /* nothing listening, which is what we want */ }
}

await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

const child = spawn('node', ['dist/http.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    LIVETENNISAPI_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
    MCP_RATE_LIMIT_ANON: String(ANON_LIMIT),
    MCP_RATE_LIMIT_KEYED: String(KEYED_LIMIT),
  },
  stdio: ['ignore', 'inherit', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });

/** `tools/list` needs no key and no upstream call — the cheapest way to spend budget. */
const hit = (headers = {}) =>
  fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }).then(async (r) => ({ status: r.status, remaining: parseRemaining(r), body: await r.json().catch(() => null) }));

/**
 * How much budget the server says this caller has left.
 *
 * Reading the header is what makes the per-caller check conclusive. Inferring
 * isolation from status codes alone does NOT work: the limit is chosen per
 * request (300 keyed / 60 anonymous) while the COUNTER may be shared, so a
 * keyed request can sail through on a shared bucket and look perfectly healthy.
 * `remaining` exposes the counter itself, which is the thing being shared.
 */
function parseRemaining(res) {
  const h = res.headers.get('ratelimit') ?? '';
  const m = /remaining=(\d+)/.exec(h);
  return m ? Number(m[1]) : null;
}

/** Spend `n` requests as one caller and report the statuses seen. */
async function burst(n, headers) {
  const seen = [];
  for (let i = 0; i < n; i++) seen.push((await hit(headers)).status);
  return seen;
}

async function main() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  // 1. An anonymous flood is eventually refused — the limiter is actually armed.
  // The bucket is fresh, so the block point is exact — request ANON_LIMIT+1 and
  // no other. A range check here is what let a broken limiter pass earlier.
  const flood = await burst(ANON_LIMIT + 3);
  if (!flood.includes(429)) fail(`anonymous caller sent ${flood.length} requests without ever being limited`);
  const firstBlock = flood.indexOf(429) + 1;
  if (firstBlock !== ANON_LIMIT + 1) {
    fail(`anonymous limit fired at request ${firstBlock}, expected exactly ${ANON_LIMIT + 1} — `
       + 'either the limit is wrong or something else is spending this bucket');
  }

  // 2. It refuses in JSON-RPC, not HTML. An MCP client handed an Express error
  //    page reports a parse failure, which sends the user debugging the wrong thing.
  const blocked = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  if (blocked.status !== 429) fail('expected the anonymous bucket to still be exhausted');
  const body = await blocked.json().catch(() => null);
  if (body?.error?.code !== -32000) fail(`429 body was not a JSON-RPC error: ${JSON.stringify(body)}`);
  if (body?.jsonrpc !== '2.0') fail(`429 body was not JSON-RPC 2.0: ${JSON.stringify(body)}`);
  if (!blocked.headers.get('ratelimit')) fail('429 carried no RateLimit header, so clients cannot back off intelligently');

  // 3. THE ONE THAT MATTERS. The anonymous bucket is exhausted. A DIFFERENT
  //    caller — same source IP, as everyone is behind the tunnel — must still be
  //    served. If this 429s, the limiter is global and one client can take the
  //    server down for every other user.
  const a = await hit({ authorization: 'Bearer twjp_caller_AAA' });
  if (a.status === 429) fail("a keyed caller was blocked by ANOTHER caller's usage — the limiter is bucketing globally");
  if (a.status !== 200) fail(`keyed caller got ${a.status}, expected 200`);
  // Caller A is brand new, so their FIRST request must leave a full budget
  // minus one. Anything less means they inherited the anonymous flood's
  // counter — i.e. one shared bucket wearing per-caller limits.
  if (a.remaining === null) fail('no RateLimit header, so per-caller budget cannot be verified');
  if (a.remaining !== KEYED_LIMIT - 1) {
    fail(`caller A's first request reported ${a.remaining} remaining, expected ${KEYED_LIMIT - 1} — `
       + `${KEYED_LIMIT - 1 - a.remaining} requests of someone else's traffic is being charged to them`);
  }

  // 4. And two distinct keys do not share a bucket either. Same direct check:
  //    after A spends heavily, B must still start from a full budget.
  await burst(ANON_LIMIT + 5, { authorization: 'Bearer twjp_caller_AAA' });
  const b = await hit({ authorization: 'Bearer twjp_caller_BBB' });
  if (b.status !== 200) fail(`caller B got ${b.status} after caller A's traffic — keys are sharing a bucket`);
  if (b.remaining !== KEYED_LIMIT - 1) {
    fail(`caller B started at ${b.remaining} remaining, expected ${KEYED_LIMIT - 1} — caller A's spend leaked into B's bucket`);
  }

  // 5. Keyed callers get the higher ceiling, but are still bounded: an
  //    authenticated client must not be able to exhaust the process either.
  const heavy = await burst(KEYED_LIMIT + 3, { authorization: 'Bearer twjp_caller_CCC' });
  if (!heavy.includes(429)) fail(`keyed caller sent ${heavy.length} requests unlimited — authenticated traffic is uncapped`);
  const keyedBlock = heavy.indexOf(429) + 1;
  if (keyedBlock !== KEYED_LIMIT + 1) {
    fail(`keyed caller blocked at request ${keyedBlock}, expected exactly ${KEYED_LIMIT + 1}`
       + (keyedBlock <= ANON_LIMIT + 1 ? ' — authenticated callers are getting the anonymous limit' : ''));
  }

  // 6. Liveness must never be rate limited, or monitoring goes blind exactly
  //    when the server is under load and you most need to know it is alive.
  const health = await fetch(`http://127.0.0.1:${PORT}/health`);
  if (!health.ok) fail(`/health returned ${health.status} while limits were exhausted — monitoring would report a false outage`);

  console.log(`OK - armed (anon blocked at ${firstBlock}/${ANON_LIMIT}, keyed at ${keyedBlock}/${KEYED_LIMIT}) · per-caller buckets · JSON-RPC 429 · /health exempt`);
}

main()
  .then(() => shutdown(0))
  .catch((e) => { console.error('FAIL:', e.message, '\n--- server stderr ---\n', stderr); shutdown(1); });

function shutdown(code) {
  child.kill('SIGKILL');
  upstream.closeAllConnections?.();
  upstream.close();
  process.exit(code);
}
