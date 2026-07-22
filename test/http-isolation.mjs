#!/usr/bin/env node
/**
 * The test this transport exists to pass: one caller's key must never serve
 * another caller.
 *
 * The stdio server reads ONE key from the environment into ONE long-lived
 * client. Exposing that over HTTP would serve every anonymous caller on the
 * operator's key, at the operator's tier. http.ts fixes that by building a
 * fresh server per request; this proves it, rather than assuming it.
 *
 * Run: node test/http-isolation.mjs        (no credentials needed)
 */

import { spawn } from 'node:child_process';

const PORT = 8123;
const URL = `http://127.0.0.1:${PORT}/mcp`;
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };

// A key the server must NEVER fall back to. If isolation is broken by someone
// re-adding a `process.env` default, calls made with no key would silently use
// this instead of reporting that no key is configured.
const OPERATOR_KEY = 'twjp_OPERATOR_SECRET_MUST_NOT_LEAK';

// Refuse to run against a server this test did not start. A leftover process
// from an earlier run will happily answer on this port, and the results then
// describe THAT build, not the one on disk — which is how a mutated server once
// made a clean build look broken for several minutes.
try {
  const stray = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1000) });
  if (stray.ok) fail(`port ${PORT} is already serving — kill the stray process before running this test`);
} catch { /* nothing listening, which is what we want */ }

const child = spawn('node', ['dist/http.js'], {
  env: { ...process.env, PORT: String(PORT), LIVETENNISAPI_KEY: OPERATOR_KEY },
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
  // Streamable HTTP may answer as SSE; pull the first data: frame if so.
  const line = raw.startsWith('event:') || raw.startsWith('data:')
    ? raw.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim()
    : raw;
  return { status: res.status, json: line ? JSON.parse(line) : null };
};

const init = (id) => ({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'isolation-test', version: '1' } },
});

async function main() {
  // wait for listen
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  // 1. Handshake works at all.
  const a = await rpc(init(1));
  if (a.json?.result?.serverInfo?.name !== 'livetennisapi') fail('initialize did not return serverInfo');

  // 2. Tools are listed without any credential — this is what an indexer does,
  //    and the whole reason for hosting.
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = list.json?.result?.tools;
  if (!Array.isArray(tools) || tools.length !== 12) fail(`expected 12 tools unauthenticated, got ${tools?.length}`);

  // 3. THE ISOLATION CHECK. Call a tool with NO key. The response must say a key
  //    is missing. If it returns data — or anything implying a working key — the
  //    server borrowed the operator's credentials from the environment.
  const anon = await rpc({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'check_api_status', arguments: {} },
  });
  const anonText = anon.json?.result?.content?.[0]?.text ?? '';
  if (!/No API key is configured/i.test(anonText)) {
    fail(`unauthenticated call did not report a missing key — operator key may have leaked.\n  got: ${anonText.slice(0, 200)}`);
  }
  if (anonText.includes(OPERATOR_KEY)) fail('operator key echoed to an anonymous caller');

  // 4. A caller-supplied key must reach the server — proven by the response
  //    CHANGING. A bogus key is rejected upstream, which is itself proof the
  //    key travelled (an ignored key would have produced case 3's text again).
  const keyed = await rpc(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'check_api_status', arguments: {} } },
    { authorization: 'Bearer twjp_definitely_not_a_real_key' },
  );
  const keyedText = keyed.json?.result?.content?.[0]?.text ?? '';
  if (/No API key is configured/i.test(keyedText)) {
    fail('caller-supplied key was ignored — the request never reached the client');
  }

  // 5. Same again via X-API-Key, so both documented shapes are covered.
  const hdr = await rpc(
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'check_api_status', arguments: {} } },
    { 'x-api-key': 'twjp_definitely_not_a_real_key' },
  );
  if (/No API key is configured/i.test(hdr.json?.result?.content?.[0]?.text ?? '')) {
    fail('X-API-Key header was ignored');
  }

  // 6. Stateless: no session id is issued, so there is no session map that could
  //    hand one caller another caller's server.
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(init(6)),
  });
  if (res.headers.get('mcp-session-id')) fail('server issued a session id; expected stateless mode');

  console.log('OK - 12 tools unauthenticated, no env-key fallback, caller keys honoured, stateless');
}

main()
  .catch((e) => { console.error('FAIL:', e.message, '\n--- server stderr ---\n', stderr); process.exit(1); })
  .finally(() => child.kill());
