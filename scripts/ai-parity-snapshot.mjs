#!/usr/bin/env node
/**
 * Snapshot the tool definitions of a livetennisapi-ai release, so that
 * test/ai-parity.mjs can hold this server to them word for word.
 *
 * The two packages describe the same 25 tools to a model. When they drift, a
 * model that learned one of them misreads the other. This writes the
 * description, input schema and output schema of every tool in the AI package
 * to test/fixtures/livetennisapi-ai-<version>.tools.json, converted to JSON
 * Schema by the same MCP SDK routine (and the same options) the server's
 * tools/list handler uses, so the two sides are comparable byte for byte.
 *
 * Usage:
 *   mkdir -p /tmp/ai && cd /tmp/ai && npm pack livetennisapi-ai@1.3.1 && tar xzf *.tgz
 *   node scripts/ai-parity-snapshot.mjs /tmp/ai/package
 *
 * The tarball's code is imported for its exported definitions only: `ai` is
 * replaced by a stub whose tool() returns its argument, and no tool is executed.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error('usage: node scripts/ai-parity-snapshot.mjs <unpacked livetennisapi-ai package dir>');
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
if (pkg.name !== 'livetennisapi-ai') {
  console.error(`expected a livetennisapi-ai package, found ${pkg.name}`);
  process.exit(2);
}

register('./ai-parity-hooks.mjs', {
  parentURL: import.meta.url,
  data: {
    ai: pathToFileURL(join(root, 'scripts', 'ai-stub.mjs')).href,
    zod: import.meta.resolve('zod'),
    livetennisapi: import.meta.resolve('livetennisapi'),
  },
});

const { toJsonSchemaCompat } = await import('@modelcontextprotocol/sdk/server/zod-json-schema-compat.js');
const entry = pathToFileURL(resolve(pkgDir, pkg.exports?.['.']?.import ?? pkg.module ?? pkg.main)).href;
const ai = await import(entry);
if (ai.VERSION !== pkg.version) {
  console.error(`package.json says ${pkg.version} but the module exports VERSION ${ai.VERSION}`);
  process.exit(2);
}

// The options mirror McpServer's tools/list handler exactly.
const input = (schema) => toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: 'input' });
const output = (schema) => toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: 'output' });

const tools = ai.livetennisTools({ apiKey: 'twjp_snapshot_only' });
const snapshot = {};
for (const name of Object.keys(tools).sort()) {
  const t = tools[name];
  snapshot[name] = {
    description: t.description,
    inputSchema: input(t.inputSchema),
    outputSchema: output(t.outputSchema),
  };
}

const out = join(root, 'test', 'fixtures', `livetennisapi-ai-${pkg.version}.tools.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ package: pkg.name, version: pkg.version, tools: snapshot }, null, 2) + '\n');
console.log(`wrote ${out}: ${Object.keys(snapshot).length} tools from ${pkg.name}@${pkg.version}`);
