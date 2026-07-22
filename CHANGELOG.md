# Changelog

All notable changes are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.2.0] — 2026-07-22

### Added
- **Structured output on every tool.** Each of the 12 tools now declares an
  `outputSchema` and returns `structuredContent` alongside the existing prose,
  so a program can read fields directly instead of re-parsing English. The prose
  is unchanged, so nothing regresses for current users.

  This is riskier than it sounds and is covered by a test accordingly. Declaring
  an output schema makes the SDK **throw** on any non-error result that omits
  structured content — and a tier wall, a missing key and an empty result are
  all deliberately non-error here. Left to each tool to remember, that would
  have 500'd all twelve at once. Instead `guard()` emits the structured half
  itself, so no individual tool can forget.

- **Tool annotations** — `readOnlyHint`, `destructiveHint: false`,
  `idempotentHint`, `openWorldHint`. These are simply true: every tool is a GET
  against a live external API. Clients can use them to decide what is safe to
  call without confirmation.

- **Titles and complete parameter descriptions** on all 12 tools, so a client
  can render and prompt for every input without guessing.

- `test/tools-output.mjs` drives all 12 tools on both the no-key and success
  paths against a stub upstream, and `test/mutate.py` now covers `src/server.ts`
  too — 13 mutations, including one that removes exactly the structured-content
  guarantee described above.

### Changed
- The no-key message no longer assumes stdio. It previously said only "set the
  LIVETENNISAPI_KEY environment variable", which is wrong advice for anyone
  calling the hosted HTTP endpoint; it now names both.
- `Match.id` and `Player.id` are nullable in the output schemas, because the
  upstream types allow their absence. Asserting otherwise would have made the
  schema lie rather than make the data safe.

## [1.1.0] — 2026-07-22

### Added
- **A Streamable-HTTP transport** (`dist/http.js`, bin
  `livetennisapi-mcp-http`), so the server can be reached over HTTP by clients
  and directories that cannot run a local stdio process. Directories that
  introspect over HTTP could previously only see an opaque bundle, and listed
  the server with no capabilities.

  It is **multi-tenant**, which is the whole design constraint. The stdio server
  reads one key from the environment into one long-lived client; hosting that
  binary as-is would serve every anonymous caller on the operator's key, at the
  operator's tier, silently and permanently. So each request builds its own
  server bound to the key that request presented, the transport runs stateless
  so no session map can hand one caller another's server, and there is
  deliberately **no fallback** to `LIVETENNISAPI_KEY`. The systemd unit clears
  that variable outright as defence in depth.

- **Per-caller rate limiting** — 60 req/min anonymous, 300 keyed, both tunable
  via `MCP_RATE_LIMIT_ANON` / `MCP_RATE_LIMIT_KEYED`. Keyed on the caller's API
  key rather than IP, because the endpoint sits behind a Cloudflare tunnel where
  every request arrives from `127.0.0.1` — an IP-keyed limiter would put every
  user in one bucket and let the first busy client lock out the rest.

- **Deployment**: a hardened systemd unit (`DynamicUser`, syscall filtering,
  loopback-only bind, memory caps) plus an install script that verifies the
  running service is loopback-bound and does not leak a key before it exits.

- **Mutation testing** (`npm run test:mutation`) covering both transport tests.
  Added because the first rate-limit test passed against a limiter that bucketed
  globally: inferring isolation from status codes cannot work, since the limit
  is chosen per request while the counter may be shared. The test now reads the
  `RateLimit` header and asserts a fresh caller starts with a full budget.

### Changed
- `src/server.ts` now holds the tool definitions, shared by both transports, so
  stdio and HTTP cannot drift apart.

## [1.0.4] — 2026-07-22

### Fixed
- **A full MCP introspection pass errored twice.** This server exposes tools
  only, and the SDK registers the `resources/*` and `prompts/*` handlers lazily
  — so `resources/list` and `prompts/list` answered `-32601 Method not found`.
  That is spec-correct (the capabilities were never advertised, so a conforming
  client would not call them), but automated indexers are not conforming
  clients: Glama documents its introspection pass as `tools/list`,
  `resources/list`, `prompts/list` run unconditionally, and a pass that errors
  twice is a plausible way to end up unindexed and unscored.

  Both now advertise the capability and return an empty collection, which is
  the honest answer — supported, nothing in it. Preferable to registering a
  placeholder resource purely to satisfy an indexer, which would put a fake
  entry in front of real users. `test/protocol.mjs` covers the full triple.

### Added
- `Dockerfile` — indexers need to build and run the server to introspect it.
  Multi-stage, dev dependencies dropped, runs as the unprivileged `node` user.
  Works with no credentials: the no-key path stays non-fatal by design.

## [1.0.3] — 2026-07-21

### Fixed
- **`check_api_status` reported a valid FREE key as "Could not reach the API".**
  The tier probe calls `listCompletedMatches()` — `/history/matches`, which is
  BASIC-gated — and did not catch `UpgradeRequired`. On a FREE key that 403
  escaped to the outer handler and was rendered as an unreachable API. The probe
  also started the ladder at `BASIC`, so a free key could never have been named
  correctly even had it not thrown. The history probe is now caught and
  identifies FREE, and the upward climb is skipped for it (a FREE key cannot
  hold PRO/ULTRA).

### Changed
- Tier legends in the probe result and the tier-wall explanation list the new
  FREE tier, and the no-key prompts point at the no-card signup
  (<https://livetennisapi.com/subscribe/free>) rather than the pricing page.
- `glama.json` claims maintainership of the Glama listing.

## [1.0.2] — 2026-07-19

### Added
- Listed in the [official MCP Registry](https://registry.modelcontextprotocol.io)
  as `io.github.livetennisapi/livetennisapi-mcp`, so MCP clients can discover the
  server programmatically. Adds `server.json` and the `mcpName` ownership marker,
  published from CI via GitHub OIDC.

### Fixed
- `check_api_status` reported a PRO or ULTRA key as BASIC whenever the events
  probe hit a match with no recorded events: `NotFound` was treated as "not
  entitled" when it actually proves the call was allowed. Only `UpgradeRequired`
  now stops the tier ladder.
- Guarded against a non-JSON response body decoding to `undefined` and being
  dereferenced in `get_match`, `get_match_score`, `get_match_odds`,
  `get_match_analysis` and `get_player`.

### Changed
- `CHANGELOG.md` is now included in the published tarball.

## [1.0.1] — 2026-07-19

### Changed
- Published from CI via npm Trusted Publishing (OIDC), so this release carries a
  signed provenance attestation. 1.0.0 did not: npm requires a package to exist
  before OIDC can be configured, so it had to be published manually.

### Added
- `test/protocol.mjs` — drives the built server over stdio and asserts the
  handshake, all 12 tools, and that the missing-key path degrades to a helpful
  message rather than an error.
- Release workflow, security policy, contributing guide, issue templates.

## [1.0.0] — 2026-07-19

First release.

### Added
- 12 read-only MCP tools over the Live Tennis API: live and upcoming matches,
  match detail and score, player search and profile, fixtures, recent results,
  match events, odds, model analysis, and an API status check.
- Tier-aware responses: a `403 upgrade_required` becomes a plain-English
  explanation naming the required plan, returned as a normal result rather than
  an error.
- `check_api_status` probes upward to report which plan the configured key is on.

### Notes
- Published without a provenance attestation. npm requires a package to exist
  before OIDC trusted publishing can be configured, so 1.0.0 had to be published
  manually. Later releases are published from CI with provenance.
