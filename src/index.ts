#!/usr/bin/env node
/**
 * stdio entry point for the Live Tennis API MCP server.
 *
 *   claude mcp add livetennis -e LIVETENNISAPI_KEY=twjp_… -- npx -y livetennisapi-mcp
 *
 * Single-tenant by design: one user, one machine, their own key read from the
 * environment. That is the right model here and the wrong one for a network
 * transport — see http.ts, which builds a server per request instead.
 *
 * The tools themselves live in server.ts so both transports share one
 * definition and cannot drift.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { VERSION, createServer } from './server.js';

const apiKey = (process.env.LIVETENNISAPI_KEY ?? '').trim();

async function main(): Promise<void> {
  const server = createServer(apiKey, process.env.LIVETENNISAPI_BASE_URL);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel — anything logged there corrupts the protocol.
  console.error(`livetennisapi-mcp ${VERSION} ready${apiKey ? '' : ' (no API key configured)'}`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
