#!/usr/bin/env node
/**
 * The bearer parser must stay linear and must return exactly what the regex
 * it replaced returned.
 *
 * `/^Bearer\s+(.+)$/i` was quadratic on `Bearer` followed by a long run of
 * spaces and a line terminator (CodeQL js/polynomial-redos). The header is
 * caller-controlled. This drives `bearerToken` with the pathological shape at
 * 100k repetitions under a tight budget, and checks parity with the old regex
 * on hand-picked corners plus a few thousand random short strings.
 *
 * Run: node test/auth.mjs        (needs `npm run build` first, no network)
 */
import { bearerToken } from '../dist/auth.js';

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };

/** The regex this parser replaced. Kept here only as the parity oracle. */
const legacy = (auth) => {
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : null;
};

// 1. Hand-picked corners: case, tabs, inner spaces, too short, all whitespace,
//    line terminators before and after the token, and non-bearer shapes.
const fixtures = [
  'Bearer twjp_abc', 'bearer twjp_abc', 'BEARER twjp_abc', 'Bearer  twjp_abc  ',
  'Bearer\ttwjp_abc', 'Bearer twjp a b', 'Bearer', 'Bearer ', 'Bearer  ', 'Bearer \t',
  'Bearer \n', 'Bearer \n twjp_abc', 'Bearer twjp_abc\n', 'Bearer twjp_abc\r\n',
  'Bearer \u2028x', 'Bearer twjp_abc', 'Bearertwjp_abc', ' Bearer twjp_abc',
  'Basic dXNlcjpwYXNz', 'X-API-Key twjp_abc', '', 'B', 'Bearer x',
];
for (const auth of fixtures) {
  const got = bearerToken(auth);
  const want = legacy(auth);
  if (got !== want) fail(`parity broke on ${JSON.stringify(auth)}: got ${JSON.stringify(got)}, regex gave ${JSON.stringify(want)}`);
}

// 2. Random short strings over an alphabet chosen to hit every branch.
const alphabet = ['B', 'e', 'a', 'r', 'E', 'R', ' ', ' ', '\t', '\n', '\r', '\u2028', 'x', '1', '_'];
let seed = 20261108;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let randomChecked = 0;
for (let n = 0; n < 5000; n += 1) {
  const len = Math.floor(rand() * 12);
  let s = rand() < 0.6 ? 'Bearer' : '';
  for (let i = 0; i < len; i += 1) s += alphabet[Math.floor(rand() * alphabet.length)];
  const got = bearerToken(s);
  const want = legacy(s);
  if (got !== want) fail(`parity broke on random ${JSON.stringify(s)}: got ${JSON.stringify(got)}, regex gave ${JSON.stringify(want)}`);
  randomChecked += 1;
}

// 3. The pathological shape at 100k repetitions. The old regex retried from
//    every space here; a linear scan finishes in well under a millisecond, so
//    50 ms is generous even on a slow CI runner and still fails a quadratic one.
const spaces = ' '.repeat(100_000);
const inputs = [`Bearer ${spaces}\n`, `Bearer ${spaces}x`, `Bearer${spaces}`];
const started = performance.now();
const results = inputs.map(bearerToken);
const elapsed = performance.now() - started;
const expected = [null, 'x', ''];
for (let i = 0; i < inputs.length; i += 1) {
  if (results[i] !== expected[i]) fail(`pathological input ${i}: got ${JSON.stringify(results[i])}, expected ${JSON.stringify(expected[i])}`);
}
if (elapsed > 50) fail(`100k-space headers took ${elapsed.toFixed(1)} ms, over the 50 ms budget`);

console.log(`OK - bearer parser matches the old regex on ${fixtures.length} fixtures + ${randomChecked} random strings · 100k spaces in ${elapsed.toFixed(2)} ms`);
