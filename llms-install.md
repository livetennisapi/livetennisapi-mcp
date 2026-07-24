# Live Tennis API MCP Server — Installation Guide

This guide is written for AI agents like Cline to install and configure the
`livetennisapi-mcp` server. Following only this file (or the README) is enough
to complete a working setup.

## Overview

`livetennisapi-mcp` gives an MCP client live tennis scores, players, fixtures
and results for ATP, WTA, Challenger and ITF — backed by the
[Live Tennis API](https://livetennisapi.com). Match events, odds and model
win-probability tools are included and require paid plans; everything else
works on the free tier.

## Prerequisites

1. **Node.js >= 18** (check with `node --version`)
2. **A Live Tennis API key.** A free key (no credit card) is available at
   <https://livetennisapi.com/subscribe/free>. Keys look like `twjp_…`.

If the user does not have a key yet, ask them to get a free one from the URL
above before continuing. The server starts without a key, but every data tool
will respond asking for one.

## Installation

No install step is needed — the server runs on demand via `npx`.

The only configuration is one environment variable:

| Variable | Required | Value |
|---|---|---|
| `LIVETENNISAPI_KEY` | yes | The user's Live Tennis API key (`twjp_…`) |

### Cline (VS Code extension)

Add this to `cline_mcp_settings.json` (open it via Cline → MCP Servers →
Configure, or find it under
`.../globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "livetennis": {
      "command": "npx",
      "args": ["-y", "livetennisapi-mcp"],
      "env": {
        "LIVETENNISAPI_KEY": "twjp_YOUR_KEY_HERE"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Replace `twjp_YOUR_KEY_HERE` with the user's actual key.

### Claude Desktop

Add the same server block to `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "livetennis": {
      "command": "npx",
      "args": ["-y", "livetennisapi-mcp"],
      "env": { "LIVETENNISAPI_KEY": "twjp_YOUR_KEY_HERE" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add livetennis -e LIVETENNISAPI_KEY=twjp_YOUR_KEY_HERE -- npx -y livetennisapi-mcp
```

### Cursor / Zed / other stdio clients

Same command (`npx -y livetennisapi-mcp`), same `LIVETENNISAPI_KEY` env var,
in that client's MCP configuration file.

### HTTP-only clients (no local process)

For clients that can only connect over HTTP, a hosted Streamable-HTTP endpoint
exists at `https://mcp.livetennisapi.com/mcp`. Authenticate with
`Authorization: Bearer twjp_…` or `X-API-Key: twjp_…` (or `?token=` if the
client cannot set headers). Prefer the stdio setup above when possible — the
key then never leaves the user's machine.

## Verify the installation

1. Restart the MCP client (or reload its MCP servers).
2. Confirm the `livetennis` server shows as connected and lists tools.
3. Call `check_api_status` — it reports whether the API is reachable and which
   plan the configured key is on.
4. Ask something like *"What tennis matches are live right now?"* — the
   `get_live_matches` tool should return current matches.

## Available tools

| Tool | Does | Plan |
|---|---|---|
| `get_live_matches` | Matches in progress, with live scores | FREE |
| `get_upcoming_matches` | Matches starting soon | FREE |
| `get_match` | Full detail for one match | FREE |
| `get_match_score` | Current score only — fastest read | FREE |
| `search_players` | Find players by name | FREE |
| `get_player` | Profile, ranking, country, handedness | FREE |
| `get_fixtures` | Forward schedule | FREE |
| `get_recent_results` | Completed matches and winners | BASIC |
| `get_match_events` | Breaks, games, sets, momentum runs | PRO |
| `get_match_odds` | Match-winner prices | PRO |
| `get_match_analysis` | Model thesis, win probability | ULTRA |
| `check_api_status` | Reachability + which plan the key is on | — |

## Troubleshooting

- **A tool answers that a higher tier is required.** That is a normal result,
  not an error: the endpoint is gated to a paid plan (see table above) and the
  configured key is on a lower one. Nothing is misconfigured. Upgrades:
  <https://livetennisapi.com/#pricing>.
- **Tools ask for an API key.** `LIVETENNISAPI_KEY` is missing from the `env`
  block, or the key was pasted with whitespace. Keys start with `twjp_`.
- **`npx` cannot find the package.** Ensure Node >= 18 and network access to
  the npm registry; the package name is exactly `livetennisapi-mcp`.
- **Which plan is my key on?** Call `check_api_status` — it probes upward and
  reports the actual plan.
