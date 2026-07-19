# Changelog

All notable changes are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

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
