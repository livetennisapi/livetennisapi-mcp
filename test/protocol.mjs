#!/usr/bin/env node
/**
 * Protocol smoke test.
 *
 * Drives the built server over stdio exactly as an MCP client would and asserts
 * the handshake, the tool inventory, and the no-key behaviour. Deliberately
 * runs WITHOUT an API key: the tools must degrade to a helpful message rather
 * than an error, and that path is what every new user hits first.
 */
import { spawn } from 'node:child_process';

const EXPECTED_TOOLS = [
  'get_live_matches', 'get_upcoming_matches', 'get_match', 'get_match_score',
  'search_players', 'get_player', 'get_fixtures', 'get_recent_results',
  'get_match_events', 'get_match_odds', 'get_match_analysis', 'check_api_status',
];

const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ci', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_live_matches', arguments: { limit: 1 } } },
  // Automated indexers (Glama et al.) run the full introspection triple
  // unconditionally, not just tools/list. These must not error.
  { jsonrpc: '2.0', id: 4, method: 'resources/list' },
  { jsonrpc: '2.0', id: 5, method: 'prompts/list' },
];

const env = { ...process.env };
delete env.LIVETENNISAPI_KEY;

const child = spawn('node', ['dist/index.js'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
let out = '';
child.stdout.on('data', (d) => { out += d; });

for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');

const done = new Promise((resolve) => setTimeout(resolve, 6000));
await done;
child.kill();

const messages = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };

const init = messages.find((m) => m.id === 1);
if (!init?.result?.serverInfo) fail('no initialize result');

const tools = messages.find((m) => m.id === 2)?.result?.tools;
if (!Array.isArray(tools)) fail('no tools/list result');
const names = tools.map((t) => t.name);
for (const expected of EXPECTED_TOOLS) {
  if (!names.includes(expected)) fail(`missing tool: ${expected}`);
}
for (const tool of tools) {
  if (!tool.description) fail(`tool ${tool.name} has no description`);
}

// Without a key, a tool must return a helpful text result — never an error.
const call = messages.find((m) => m.id === 3)?.result;
if (!call) fail('no tools/call result');
if (call.isError) fail('missing-key path returned isError; it must degrade gracefully');
const text = call.content?.[0]?.text ?? '';
if (!/LIVETENNISAPI_KEY/.test(text)) fail('missing-key message does not name the env var');

// A full introspection pass must not error. This server exposes no resources or
// prompts, but an indexer that calls them regardless has to get an empty list
// rather than -32601, or the run can be recorded as a failed introspection.
for (const [id, key] of [[4, 'resources'], [5, 'prompts']]) {
  const m = messages.find((x) => x.id === id);
  if (!m) fail(`no response to ${key}/list`);
  if (m.error) fail(`${key}/list errored (${m.error.code}); indexers call it unconditionally`);
  if (!Array.isArray(m.result?.[key])) fail(`${key}/list did not return a ${key} array`);
}

if (!init.result.capabilities?.resources) fail('resources capability not advertised');
if (!init.result.capabilities?.prompts) fail('prompts capability not advertised');

console.log(`OK - handshake, ${tools.length} tools, empty resources/prompts, graceful no-key path`);
