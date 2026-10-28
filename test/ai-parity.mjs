#!/usr/bin/env node
/**
 * The 24 tools this server shares with livetennisapi-ai must be defined the
 * same way in both packages: the same description, the same input schema and
 * the same output schema, field descriptions included.
 *
 * Why word for word
 * -----------------
 * Both packages put these definitions in front of a model. A model that learned
 * one package's wording misreads the other's when they drift, and two readers
 * of the two packages get different answers to "what does this field mean".
 * So this compares the server's live tools/list output to a vendored snapshot
 * of the AI package (test/fixtures/livetennisapi-ai-<version>.tools.json,
 * written by scripts/ai-parity-snapshot.mjs with the same JSON Schema
 * conversion the SDK applies here). Any difference, down to one character of a
 * field description, fails the test and is printed with its path.
 *
 * player_stats is this server's own and has no AI counterpart yet; it is listed
 * in EXTRA so a new tool on either side is a deliberate change, not a silent one.
 *
 * REWORDED lists the phrases this server words differently from the snapshot
 * until livetennisapi-ai ships the same wording. Each pair is applied to the
 * snapshot's descriptions before the comparison, so everything else must still match
 * to the character, and a pair the snapshot no longer contains fails the test.
 * Once the AI package carries the new wording, refresh the snapshot and empty
 * the list.
 *
 * Run: node test/ai-parity.mjs        (no credentials, no network)
 */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const file = readdirSync(fixtures).filter((f) => /^livetennisapi-ai-.*\.tools\.json$/.test(f)).sort().at(-1);
if (!file) { console.error('FAIL: no livetennisapi-ai snapshot under test/fixtures'); process.exit(1); }
const snapshot = JSON.parse(readFileSync(join(fixtures, file), 'utf8'));

/** Tools this server has that the AI package does not. */
const EXTRA = ['player_stats'];

/** [snapshot phrase, this server's phrase]: see REWORDED in the header. */
const REWORDED = [
  ['Null when the feed never stated one (exhibitions, team events).', 'Null when no tour is recorded (exhibitions, team events).'],
  ['Null when the feed has not published one.', 'Null when no start time is set yet.'],
  ['Set only where the catalogues agree unambiguously.', 'Set only where the category is unambiguous.'],
  ['W-L per source tier code.', 'W-L per tier code.'],
  ['Source tier code', 'Tier code'],
  ['Counted upstream:', 'Counted per match:'],
  ['MEASURED is counted upstream.', 'MEASURED is counted per match.'],
  ['Career shot-level profile from the Match Charting Project,', 'Career profile from shot-level charting data,'],
  ['Every Match Charting Project stat family', 'Every charting stat family'],
  ["The Match Charting Project's own row identifier.", "The charting dataset's own row identifier."],
  ["Career-high rank, from the corpus's own weekly tables.", "Career-high rank, from the archive's weekly ranking tables."],
];
const reworded = new Map(REWORDED.map(([from]) => [from, 0]));

/**
 * The snapshot value with every REWORDED pair applied to its description
 * strings, counting uses. Names, enums, defaults and every other value are
 * left alone, so a pair can never hide a change to them.
 */
function reword(v, key) {
  if (typeof v === 'string' && key === 'description') {
    let s = v;
    for (const [from, to] of REWORDED) {
      if (s.includes(from)) { reworded.set(from, reworded.get(from) + 1); s = s.split(from).join(to); }
    }
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => reword(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reword(x, k)]));
  return v;
}

const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ci', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
];

const env = { ...process.env };
delete env.LIVETENNISAPI_KEY;
const child = spawn('node', ['dist/index.js'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
let out = '';
child.stdout.on('data', (d) => { out += d; });
for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');

const listed = await new Promise((resolve, reject) => {
  const deadline = setTimeout(() => reject(new Error('no tools/list reply within 6s')), 6000);
  child.stdout.on('data', () => {
    for (const line of out.split('\n')) {
      try {
        const m = JSON.parse(line);
        if (m.id === 2 && m.result?.tools) { clearTimeout(deadline); resolve(m.result.tools); }
      } catch { /* partial line */ }
    }
  });
}).finally(() => child.kill());

const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };

/** Every path at which two JSON values differ, with both sides shown. */
function diff(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const isObj = (v) => v && typeof v === 'object';
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    return [`${path || '<root>'}\n    mcp: ${JSON.stringify(a)}\n    ai:  ${JSON.stringify(b)}`];
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const out = [];
  for (const k of keys) out.push(...diff(a[k], b[k], path ? `${path}.${k}` : k));
  // Same members, different order: JSON.stringify differs while every leaf matches.
  if (!out.length && !Array.isArray(a)) {
    out.push(`${path || '<root>'}: key order differs\n    mcp: ${Object.keys(a).join(',')}\n    ai:  ${Object.keys(b).join(',')}`);
  }
  return out;
}

const byName = new Map(listed.map((t) => [t.name, t]));
const shared = Object.keys(snapshot.tools);
const problems = [];

for (const name of shared) {
  const mcp = byName.get(name);
  if (!mcp) { problems.push(`${name}: in ${snapshot.package} ${snapshot.version} but not in this server`); continue; }
  const ai = reword(snapshot.tools[name]);
  const mine = { description: mcp.description, inputSchema: mcp.inputSchema, outputSchema: mcp.outputSchema };
  for (const d of diff(mine, ai)) problems.push(`${name}.${d}`);
}
for (const t of listed) {
  if (!snapshot.tools[t.name] && !EXTRA.includes(t.name)) {
    problems.push(`${t.name}: in this server but neither in ${snapshot.package} ${snapshot.version} nor listed as EXTRA`);
  }
}
for (const name of EXTRA) {
  if (!byName.has(name)) problems.push(`${name}: listed as EXTRA but this server does not expose it`);
  if (snapshot.tools[name]) problems.push(`${name}: listed as EXTRA but ${snapshot.package} ${snapshot.version} has it too`);
}

for (const [from, uses] of reworded) {
  if (!uses) problems.push(`REWORDED: ${snapshot.package} ${snapshot.version} no longer contains ${JSON.stringify(from)}; drop the pair`);
}

if (problems.length) {
  console.error(`FAIL: ${problems.length} difference(s) from ${snapshot.package} ${snapshot.version}:\n\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`OK - ${shared.length} shared tools match ${snapshot.package} ${snapshot.version} word for word (description, input and output schemas) · ${REWORDED.length} reworded phrase(s) · ${EXTRA.length} extra: ${EXTRA.join(', ')}`);
