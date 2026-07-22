<div align="center">

<img src="https://raw.githubusercontent.com/livetennisapi/.github/main/profile/banner.jpg" alt="Live Tennis API" width="640">

# livetennisapi-mcp

**MCP server for the [Live Tennis API](https://livetennisapi.com).**

Give Claude, Cursor, Zed or any MCP client live tennis scores, players and
fixtures — for ATP, WTA, Challenger and ITF. Odds and model win-probability
tools are included, and require the PRO and ULTRA plans.

[![npm](https://img.shields.io/npm/v/livetennisapi-mcp.svg)](https://www.npmjs.com/package/livetennisapi-mcp)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[**Documentation**](https://docs.livetennisapi.com) · [**Get a free API key**](https://livetennisapi.com/subscribe/free)

</div>

---

## Setup

**Claude Code**

```bash
claude mcp add livetennis -e LIVETENNISAPI_KEY=twjp_… -- npx -y livetennisapi-mcp
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "livetennis": {
      "command": "npx",
      "args": ["-y", "livetennisapi-mcp"],
      "env": { "LIVETENNISAPI_KEY": "twjp_…" }
    }
  }
}
```

**Cursor / Zed / others** — same command, same env var. No install step; `npx`
fetches it on demand.

Get a **free** key (no card) at [livetennisapi.com](https://livetennisapi.com/subscribe/free), or a paid plan at [pricing](https://livetennisapi.com/#pricing).

## Try it

> *"What tennis matches are live right now?"*
> *"Who's winning the Alcaraz match, and what does the model give him?"*
> *"Show me Sinner's ranking and recent results."*
> *"What are the current odds on match 18953?"*

## Tools

| Tool | Does | Plan |
|---|---|:--:|
| `get_live_matches` | Matches in progress, with live scores | FREE |
| `get_upcoming_matches` | Matches starting soon | FREE |
| `get_match` | Full detail for one match | FREE |
| `get_match_score` | Current score only — fastest read | FREE |
| `search_players` | Find players by name | FREE |
| `get_player` | Profile, ranking, country, handedness | FREE |
| `get_fixtures` | Forward schedule | FREE |
| `get_recent_results` | Completed matches and winners | BASIC |
| `get_match_events` | Breaks, games, sets, momentum runs | PRO |
| `get_match_odds` | Match-winner prices — bid / ask / mid | PRO |
| `get_match_analysis` | Model thesis, win probability, key factors | ULTRA |
| `check_api_status` | Reachability + which plan your key is on | — |

## Tier awareness

The API gates endpoints by plan and returns a bare `403 {"error":"upgrade_required"}`.
Handed that, a model will usually invent a reason or retry pointlessly.

So every tool that can hit a tier wall returns a plain-English explanation —
**as a normal result, not an error** — naming the tier required and where to
upgrade. The assistant can then tell you something true and actionable:

> This data requires the ULTRA plan, and the configured API key is on a lower
> tier. Nothing is wrong with the key — the endpoint is simply not included in
> the current plan. Upgrade at https://livetennisapi.com/#pricing

`check_api_status` probes upward to report which plan your key is actually on,
so you can diagnose that without guessing.

## Plans

| | BASIC | PRO | ULTRA |
|---|:--:|:--:|:--:|
| Matches, scores, players, fixtures, results | ✅ | ✅ | ✅ |
| Match events + odds | — | ✅ | ✅ |
| Model analysis + win probability | — | — | ✅ |

## Hosted endpoint

Most people should use the stdio server above — your key never leaves your
machine. For clients that can only speak HTTP, there is also a hosted
Streamable-HTTP endpoint:

```
https://mcp.livetennisapi.com/mcp
```

Send your key as `Authorization: Bearer twjp_…`, `X-API-Key: twjp_…`, or
`?token=` if your client cannot set headers. Tools are listable without a key,
so directories can introspect the server; calling one needs a key.

It is multi-tenant and holds **no key of its own**: every request builds its own
server bound to the key that request presented, and there is deliberately no
fallback to the host's environment. Rate limited per caller — 60 req/min
anonymous, 300 keyed — with your real quota enforced upstream per key and tier.

Self-hosting it: `deploy/install-http.sh` and `deploy/TUNNEL.md`.

## Use with Claude

**As a connector.** In Claude, add a custom connector and paste the endpoint with
your key as a query parameter — no OAuth, nothing to install:

```
https://mcp.livetennisapi.com/mcp?token=twjp_…
```

`?token=` exists for clients that cannot set request headers. The tradeoff, stated
plainly: a key in a URL is not written to our logs, but it *is* visible to the CDN
in front of the endpoint and is stored in the connector's configuration. Prefer
`Authorization: Bearer twjp_…` wherever your client lets you set a header.

**From the Messages API.** Claude can call the endpoint directly. Both halves are
required — the server *and* a matching toolset entry; sending `mcp_servers` alone
is rejected as a validation error:

```python
client.beta.messages.create(
    model="claude-opus-4-8",
    max_tokens=4096,
    betas=["mcp-client-2025-11-20"],
    mcp_servers=[{
        "type": "url",
        "name": "livetennisapi",
        "url": "https://mcp.livetennisapi.com/mcp",
        "authorization_token": os.environ["LIVETENNISAPI_KEY"],
    }],
    tools=[{"type": "mcp_toolset", "mcp_server_name": "livetennisapi"}],
    messages=[{"role": "user", "content": "What tennis is live right now?"}],
)
```

The `authorization_token` is sent as a bearer token, which is exactly what this
server already accepts — no separate credential to obtain.

## Use with Codex

One command:

```bash
codex mcp add livetennisapi \
  --url https://mcp.livetennisapi.com/mcp \
  --bearer-token-env-var LIVETENNISAPI_KEY
```

Or write it to `~/.codex/config.toml` yourself — Codex shares that file across the
CLI, the IDE extension and the desktop app:

```toml
[mcp_servers.livetennisapi]
url = "https://mcp.livetennisapi.com/mcp"
bearer_token_env_var = "LIVETENNISAPI_KEY"
```

Use `bearer_token_env_var`, not `bearer_token`: it keeps the key in your
environment rather than committing it to a config file.

There is also a **Codex plugin**, on its own marketplace:

```bash
codex plugin marketplace add livetennisapi/livetennisapi-codex-plugin
```

That registers the marketplace; install the plugin from Codex's plugin picker.
Source: [livetennisapi-codex-plugin](https://github.com/livetennisapi/livetennisapi-codex-plugin).

The stdio route works too, unchanged: `npx -y livetennisapi-mcp`.

## Notes

- **Read-only.** Every tool is a GET; nothing here can modify anything.
- **Your key stays local** with the stdio server. It is read from the
  environment by the server process on your machine and sent only to
  `api.livetennisapi.com`.
- Requires Node 18+.

## Development

```bash
npm install
npm run build
LIVETENNISAPI_KEY=twjp_… node dist/index.js   # speaks MCP over stdio
node dist/http.js                             # speaks MCP over HTTP, port 8081

npm test               # protocol + transport isolation + rate limiting
npm run test:mutation  # proves those tests fail when the code breaks
```

`test:mutation` is worth understanding before changing `src/http.ts`. It
reintroduces each bug the tests claim to catch and asserts the suite goes red.
It is not ceremony: the first version of the rate-limit test passed while the
limiter was bucketing every caller together.

Built on the official [`livetennisapi`](https://www.npmjs.com/package/livetennisapi)
client.

## Related

Everything in the Live Tennis API developer surface:

| | Install | Source | Package |
|---|---|---|---|
| Python client | `pip install livetennisapi` | [repo](https://github.com/livetennisapi/livetennisapi-python) | [package](https://pypi.org/project/livetennisapi/) |
| JavaScript / TypeScript client | `npm install livetennisapi` | [repo](https://github.com/livetennisapi/livetennisapi-js) | [package](https://www.npmjs.com/package/livetennisapi) |
| MCP server for LLM agents **(this repo)** | `npx livetennisapi-mcp` | — | [package](https://www.npmjs.com/package/livetennisapi-mcp) |

- **API reference** — <https://docs.livetennisapi.com> ([plain-HTML version](https://docs.livetennisapi.com/reference.html), no JavaScript required)
- **OpenAPI 3.1 specification** — [livetennisapi/openapi](https://github.com/livetennisapi/openapi)
- **Website and plans** — <https://livetennisapi.com>

## Licence

MIT — see [LICENSE](LICENSE). Use of the API service is governed by the
[Terms of Service](https://livetennisapi.com/terms).
