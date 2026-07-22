#!/usr/bin/env bash
# Install (or upgrade) the MCP Streamable-HTTP endpoint as a systemd service.
#
#   sudo deploy/install-http.sh [version]     # default: latest
#
# Idempotent — safe to re-run to upgrade. Installs the published npm package
# rather than building from a checkout, so what runs in production is byte-for-
# byte what users get from `npx`, with npm provenance attached.
#
# This does NOT touch the Cloudflare tunnel. Adding the ingress rule is a
# separate, reviewable step — see deploy/TUNNEL.md.
set -euo pipefail

VERSION="${1:-latest}"
UNIT_NAME='livetennisapi-mcp-http.service'
UNIT_SRC="$(cd "$(dirname "$0")" && pwd)/$UNIT_NAME"
UNIT_DST="/etc/systemd/system/$UNIT_NAME"
PORT=8081

die() { echo "ERROR: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "must be run as root (sudo)"
[[ -f "$UNIT_SRC" ]] || die "$UNIT_SRC not found"
command -v node >/dev/null || die "node is not installed"

# The package requires node >=18; a silent mismatch shows up later as a syntax
# error in a journal nobody is reading.
node_major=$(node -p 'process.versions.node.split(".")[0]')
(( node_major >= 18 )) || die "node >=18 required, found $(node -v)"

# Refuse to fight another service for the port. Our own unit is fine — that is
# an upgrade — but anything else means the port was reassigned and this unit's
# HOST/PORT needs revisiting rather than silently failing to bind on restart.
if ss -lntp 2>/dev/null | grep -q ":$PORT "; then
    if ! systemctl is-active --quiet "$UNIT_NAME"; then
        ss -lntp | grep ":$PORT " >&2
        die "port $PORT is held by something other than $UNIT_NAME"
    fi
    echo "-> port $PORT held by $UNIT_NAME (upgrade in place)"
fi

echo "==> installing livetennisapi-mcp@$VERSION"
npm install -g "livetennisapi-mcp@$VERSION"

BIN="$(command -v livetennisapi-mcp-http || true)"
[[ -n "$BIN" ]] || die "livetennisapi-mcp-http not on PATH after install — does this version ship the http bin?"
[[ -x "$BIN" ]] || die "$BIN is not executable"
echo "-> binary: $BIN"

installed=$(npm list -g --depth 0 livetennisapi-mcp 2>/dev/null | grep -oP 'livetennisapi-mcp@\K[0-9.]+' || echo '?')
echo "-> installed version: $installed"

echo "==> installing $UNIT_DST"
sed "s#__MCP_HTTP_BIN__#${BIN}#" "$UNIT_SRC" > "$UNIT_DST"
chmod 0644 "$UNIT_DST"
# `grep -q ... && die` would abort the script on the SUCCESS path here: grep
# exits 1 when it finds nothing, and under `set -e` that non-zero compound
# status ends the run. Use an if-block so only a real leftover placeholder dies.
if grep -q '__MCP_HTTP_BIN__' "$UNIT_DST"; then
    die "placeholder substitution failed — unit still contains __MCP_HTTP_BIN__"
fi

systemctl daemon-reload
systemctl enable "$UNIT_NAME" >/dev/null
systemctl restart "$UNIT_NAME"

echo "==> verifying"
for _ in $(seq 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
    sleep 0.5
done

health=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" 2>/dev/null) \
    || { journalctl -u "$UNIT_NAME" -n 30 --no-pager >&2; die "service did not come up"; }
echo "-> /health: $health"

# Bound to loopback ONLY. If this ever binds 0.0.0.0 the endpoint is exposed
# directly on the public IP, bypassing the tunnel and Cloudflare entirely.
if ss -lnt | awk '{print $4}' | grep -qE "^(0\.0\.0\.0|\[::\]):$PORT$"; then
    ss -lnt | grep ":$PORT" >&2
    die "SERVICE IS LISTENING ON ALL INTERFACES — stop it and fix HOST before proceeding"
fi
echo "-> bound to loopback only: $(ss -lnt | grep ":$PORT " | awk '{print $4}')"

# The whole point of the multi-tenant transport: an anonymous caller must not be
# served on the operator's key. Prove it against the RUNNING service, not the
# source, because a stale global install would pass every test in the repo.
anon=$(curl -fsS --max-time 10 -X POST "http://127.0.0.1:$PORT/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_live_matches","arguments":{"limit":1}}}' 2>/dev/null || true)
if grep -q 'No API key configured' <<<"$anon"; then
    echo "-> anonymous calls correctly get no credentials"
else
    echo "!! UNEXPECTED anonymous response — the operator key may be leaking:" >&2
    echo "$anon" | head -c 400 >&2; echo >&2
    die "refusing to leave a possibly key-leaking endpoint running"
fi

tools=$(curl -fsS --max-time 10 -X POST "http://127.0.0.1:$PORT/mcp" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>/dev/null | grep -o '"name"' | wc -l)
echo "-> tools listable unauthenticated: $tools"

echo
echo "OK. $UNIT_NAME is running on 127.0.0.1:$PORT"
echo "Next: add the tunnel ingress rule (deploy/TUNNEL.md) — until then this is"
echo "reachable only from the host itself."
