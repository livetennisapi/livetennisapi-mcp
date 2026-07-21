# Changelog

All notable changes are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

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
