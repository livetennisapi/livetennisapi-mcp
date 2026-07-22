#!/usr/bin/env node
/**
 * Streamable-HTTP entry point — a MULTI-TENANT host for the same 12 tools.
 *
 * Why this file exists at all: directories like Smithery can only introspect a
 * server they can reach over HTTP. A local stdio bundle is opaque to them, so
 * it lists with no capabilities.
 *
 * The security property that makes it safe
 * ----------------------------------------
 * The stdio server reads ONE key from the environment into ONE long-lived
 * client. Exposing that binary over HTTP would serve every anonymous caller on
 * the operator's key, at the operator's tier — a silent, permanent giveaway of
 * paid data.
 *
 * So here the key is per-request and nothing is shared:
 *
 *   - Every request builds its OWN `createServer(callerKey)`, whose client and
 *     tool closures exist only for that request.
 *   - The transport runs STATELESS (`sessionIdGenerator: undefined`), so there
 *     is no session map that could hand one caller another's server.
 *   - Both are closed when the response closes.
 *
 * There is deliberately no fallback to `process.env.LIVETENNISAPI_KEY`. A
 * missing caller key yields a server with an empty key — which every tool
 * already handles by explaining how to get one — rather than quietly borrowing
 * the operator's credentials. That fallback is exactly the bug this file exists
 * to avoid, so it must never be added "for convenience".
 */

import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Request, type Response } from 'express';

import { VERSION, createServer } from './server.js';

const PORT = Number(process.env.PORT ?? 8081);
const HOST = process.env.HOST ?? '127.0.0.1';
const BASE_URL = process.env.LIVETENNISAPI_BASE_URL;

/**
 * Pull the caller's key off the request.
 *
 * Accepts the same shapes the REST API does, so a user needs to learn only one
 * convention: `Authorization: Bearer …`, `X-API-Key: …`, or `?token=` /
 * `?api_key=` for clients that cannot set headers.
 *
 * Never falls back to the process environment — see the file header.
 */
function callerKey(req: Request): string {
  const auth = req.get('authorization') ?? '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();

  const header = req.get('x-api-key');
  if (header) return header.trim();

  const q = req.query.token ?? req.query.api_key;
  if (typeof q === 'string') return q.trim();

  return '';
}

const app = express();
app.use(express.json({ limit: '1mb' }));

// Browser clients need CORS, and `mcp-session-id` must be exposed or the
// Streamable-HTTP client cannot read it. Wildcard origin with no credentials:
// authentication is the caller's own key, never a cookie.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, X-API-Key, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '86400');
    res.sendStatus(204);
    return;
  }
  next();
});

// Liveness only. Deliberately says nothing about keys or tiers.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: 'livetennisapi-mcp', version: VERSION });
});

app.post('/mcp', async (req: Request, res: Response) => {
  const id = randomUUID().slice(0, 8);
  // One server + one transport per request, bound to this caller's key alone.
  const server = createServer(callerKey(req), BASE_URL);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    // Order matters: close the transport first so in-flight writes stop before
    // the server tears its handlers down.
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(`[${id}] request failed:`, err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// Stateless mode supports POST only; answer the others honestly rather than
// letting them 404 as if the endpoint did not exist.
const notAllowed = (_req: Request, res: Response) =>
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. This endpoint is stateless; use POST.' },
    id: null,
  });
app.get('/mcp', notAllowed);
app.delete('/mcp', notAllowed);

const httpServer = app.listen(PORT, HOST, () => {
  console.error(`livetennisapi-mcp ${VERSION} (streamable-http) listening on ${HOST}:${PORT}`);
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    httpServer.close(() => process.exit(0));
  });
}
