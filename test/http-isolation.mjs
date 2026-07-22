#!/usr/bin/env node
/**
 * The test this transport exists to pass: one caller's key must never serve
 * another caller.
 *
 * The stdio server reads ONE key from the environment into ONE long-lived
 * client. Exposing that over HTTP would serve every anonymous caller on the
 * operator's key, at the operator's tier. http.ts fixes that by building a
 * fresh server per request; this proves it rather than assuming it.
 *
 * How it proves it
 * ----------------
 * A stub stands in for api.livetennisapi.com and RECORDS the Authorization
 * header of every request it receives. So the assertions observe the credential
 * that actually left the process, instead of inferring it from an error string.
 * That also keeps the whole run local and fast — an earlier version made real
 * network calls and took minutes to fail.
 *
 * Run: node test/http-isolation.mjs        (no credentials, no network)
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const PORT = 8123;
const UPSTREAM_PORT = 8124;
const URL = `http://127.0.0.1:${PORT}/mcp`;
// Throws rather than exiting, so failure unwinds into main()'s catch and runs
// shutdown() — an exit() here would strand the spawned server holding the test
// port, and the NEXT run would then silently measure that stale process.
const fail = (m) => { throw new Error(m); };
/** Bail before the server is spawned, where there is nothing to clean up. */
const die = (m) => { console.error('FAIL:', m); process.exit(1); };

// A key the hosted server must NEVER fall back to.
const OPERATOR_KEY = 'twjp_OPERATOR_SECRET_MUST_NOT_LEAK';
const CALLER_A = 'twjp_caller_AAA';
const CALLER_B = 'twjp_caller_BBB';

// -- stub upstream ----------------------------------------------------------
/** Every credential the MCP server presented upstream, in order. */
const seen = [];
const upstream = createServer((req, res) => {
  const auth = req.headers.authorization ?? req.headers['x-api-key'] ?? null;
  seen.push({ path: req.url, key: auth ? String(auth).replace(/^Bearer\s+/i, '') : null });
  res.writeHead(200, { 'content-type': 'application/json' });
  // Shape-compatible enough for the tools we call.
  if (req.url?.startsWith('/health')) return res.end(JSON.stringify({ status: 'ok', version: 'v1' }));
  res.end(JSON.stringify({ data: [], meta: { limit: 1, offset: 0, count: 0 } }));
});

// -- guards -----------------------------------------------------------------
// Refuse to run against a server this test did not start. A leftover process
// from an earlier run answers happily, and the results then describe THAT
// build, not the one on disk — which once made a clean build look broken for
// several minutes.
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
    LIVETENNISAPI_KEY: OPERATOR_KEY,                       // must never be used
    LIVETENNISAPI_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
  },
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
  return { status: res.status, headers: res.headers, json: line ? JSON.parse(line) : null };
};

// check_api_status calls health() BEFORE it inspects the key, so it always
// produces an observable upstream request — including when unauthenticated,
// where guard() would otherwise short-circuit and prove nothing.
const call = (id, headers) => rpc(
  { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'check_api_status', arguments: {} } },
  headers,
);

async function main() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  // 1. Handshake.
  const a = await rpc({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  if (a.json?.result?.serverInfo?.name !== 'livetennisapi') fail('initialize did not return serverInfo');

  // 2. Tools listable with NO credential — this is exactly what an indexer does,
  //    and the reason for hosting at all.
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  if (list.json?.result?.tools?.length !== 12) fail(`expected 12 tools unauthenticated, got ${list.json?.result?.tools?.length}`);

  // 3. THE ISOLATION CHECK, observed directly. An anonymous tool call must reach
  //    upstream with NO credential. If the operator key appears here, the server
  //    borrowed it from the environment.
  seen.length = 0;
  await call(3);
  const leaked = seen.filter((r) => r.key === OPERATOR_KEY);
  if (leaked.length) fail(`OPERATOR KEY LEAKED to an anonymous caller on ${leaked.length} upstream request(s)`);
  if (seen.some((r) => r.key)) fail(`anonymous call presented a credential upstream: ${seen.map((r) => r.key).join(', ')}`);
  if (!seen.length) fail('anonymous call produced no upstream request — check_api_status should always call health()');

  // 4. A caller's key must reach upstream — and be exactly theirs.
  seen.length = 0;
  await call(4, { authorization: `Bearer ${CALLER_A}` });
  if (!seen.length) fail('keyed call never reached upstream');
  if (!seen.every((r) => r.key === CALLER_A)) fail(`caller A's request carried: ${seen.map((r) => r.key).join(', ')}`);

  // 5. X-API-Key is honoured too (both documented shapes).
  seen.length = 0;
  await call(5, { 'x-api-key': CALLER_B });
  if (!seen.every((r) => r.key === CALLER_B)) fail(`X-API-Key ignored; upstream saw: ${seen.map((r) => r.key).join(', ')}`);

  // 6. Back-to-back callers do not bleed into one another. This is the property
  //    a shared long-lived client would violate.
  seen.length = 0;
  await call(6, { authorization: `Bearer ${CALLER_A}` });
  await call(7, { authorization: `Bearer ${CALLER_B}` });
  await call(8);
  const keys = seen.map((r) => r.key);
  if (keys.includes(OPERATOR_KEY)) fail('operator key appeared during interleaved calls');
  if (!keys.includes(CALLER_A) || !keys.includes(CALLER_B)) fail(`interleaved calls lost a caller key: ${keys.join(', ')}`);
  if (keys.filter((k) => k === null).length === 0) fail('the final anonymous call still carried a credential');

  // 7. Stateless: no session id, so there is no session map to mix callers up.
  if (a.headers.get('mcp-session-id')) fail('server issued a session id; expected stateless mode');

  console.log('OK - 12 tools unauthenticated · operator key never leaves · caller keys exact · no bleed · stateless');
}

main()
  .then(() => shutdown(0))
  .catch((e) => { console.error('FAIL:', e.message, '\n--- server stderr ---\n', stderr); shutdown(1); });

/**
 * Exit deterministically. `server.close()` waits for keep-alive sockets to
 * drain, and the MCP server holds one open to the stub — so closing politely
 * hangs forever after a PASSING run. Drop the sockets, then exit outright.
 */
function shutdown(code) {
  child.kill('SIGKILL');
  upstream.closeAllConnections?.();
  upstream.close();
  process.exit(code);
}
