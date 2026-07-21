<div align="center">

<img src="https://raw.githubusercontent.com/livetennisapi/.github/main/profile/banner.jpg" alt="Live Tennis API" width="640">

# livetennisapi-mcp

**MCP server for the [Live Tennis API](https://livetennisapi.com).**

Give Claude, Cursor, Zed or any MCP client live tennis scores, players, odds
and model win-probability — for ATP, WTA, Challenger and ITF.

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

## Notes

- **Read-only.** Every tool is a GET; nothing here can modify anything.
- **Your key stays local.** It is read from the environment by the server
  process on your machine and sent only to `api.livetennisapi.com`.
- Requires Node 18+.

## Development

```bash
npm install
npm run build
LIVETENNISAPI_KEY=twjp_… node dist/index.js   # speaks MCP over stdio
```

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
