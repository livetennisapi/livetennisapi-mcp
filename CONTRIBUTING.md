# Contributing

## Setup

```bash
npm install
npm run typecheck
npm run build
```

## Running it

The server speaks MCP over stdio, so it is easiest to drive with a real client:

```bash
claude mcp add livetennis-dev -e LIVETENNISAPI_KEY=twjp_… -- node ./dist/index.js
```

Or exercise the protocol directly:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"dev","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| node dist/index.js
```

## Two rules specific to this server

1. **Never write to stdout.** stdout is the MCP transport; a stray `console.log`
   corrupts the protocol stream. Use `console.error` for diagnostics.
2. **A tier wall is not an error.** When the API returns
   `403 upgrade_required`, return a normal text result explaining which plan is
   needed. Marking it `isError` makes clients retry or bail, which loses the one
   piece of information the user actually needs.

## Adding a tool

Keep tool output compact and human-readable — it is consumed by a model with a
token budget, not parsed by code. Prefer a short labelled summary over dumping
raw JSON.
