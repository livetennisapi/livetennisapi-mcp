# Exposing the MCP endpoint through the Cloudflare tunnel

The service binds `127.0.0.1:8081` and nothing else. The only way in is the
tunnel that already fronts the API.

## The ingress rule

`/etc/cloudflared/config.yml` on the host, added **above** the catch-all
`- service: http_status:404` (cloudflared matches top to bottom and the first
match wins, so a rule placed after the catch-all is dead):

```yaml
  # MCP Streamable-HTTP endpoint. Must stay OUTSIDE Cloudflare Access — see below.
  - hostname: mcp.livetennisapi.com
    service: http://localhost:8081
```

Then a proxied DNS record so the hostname resolves to the tunnel:

```sh
cloudflared tunnel route dns <tunnel-name> mcp.livetennisapi.com
```

Reload with `docker restart cloudflared-tennis` (the tunnel runs as a container
here, `network_mode: host`, which is why `localhost:8081` resolves to the host's
port).

> **Do not try `docker kill -s HUP`.** SIGHUP is cloudflared's config-reload
> signal when it runs as a plain process, but this container does not handle it
> — the signal terminates it outright. Doing that took the tunnel down for ~30s
> and 502'd `api.livetennisapi.com`, the marketing site, the affiliate portal
> and the blog until `docker start`. A plain `docker restart` costs the same
> ~30s of reconnect but is at least predictable. There is no zero-downtime
> reload available here; treat any ingress change as a brief public outage and
> make it deliberately.

### DNS: mind which zone your credentials cover

`cloudflared tunnel route dns` infers the zone from the hostname, using whatever
`~/.cloudflared/cert.pem` is authorized for. If that cert does **not** cover the
zone you named, it does not fail — it silently creates the record as a
*subdomain of the zone it does have*. Asking for `mcp.livetennisapi.com` with a
cert scoped to `the-supervisor.us` produces `mcp.livetennisapi.com.the-supervisor.us`,
which resolves, proxies, and looks like success in the log line.

Check the output hostname, not just the exit code. `cloudflared` has no command
to delete a DNS record, so cleaning up requires the dashboard or the API.

## Do not put this hostname behind Cloudflare Access

`tennis.the-supervisor.us` is behind Access with GitHub SSO. This hostname must
not be, and the reason is the entire purpose of the service: the clients are
**automated directory indexers** — Smithery, Glama — which are anonymous by
construction. Access would answer their `initialize` with an HTML login page,
they would record the server as having no capabilities, and we would be back to
exactly the unlisted state this was built to fix.

That is safe here in a way it would not be for the trading app, because the
endpoint holds no credentials of its own. It serves each caller on the key
**they** present; an anonymous caller gets tools they cannot successfully call
and a message explaining where to get a key. There is nothing behind it to
protect with SSO.

## What protects it instead

| Layer | What it does |
|---|---|
| Cloudflare edge | DDoS absorption, TLS termination; the origin IP is never exposed |
| Loopback bind | No inbound firewall hole; unreachable except via the tunnel |
| Per-caller rate limit | 60/min anonymous, 300/min keyed — keyed on API key, not IP |
| Upstream API auth | Every tool call is metered and authorised per key and tier |
| `DynamicUser` + syscall filter | Compromise yields an ephemeral user owning nothing |
| `MemoryMax=256M` | A flood cannot starve the trading app sharing this host |

## Verifying from outside

```sh
curl -sS https://mcp.livetennisapi.com/health

curl -sS -X POST https://mcp.livetennisapi.com/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

The second must return 12 tools **without** a key. If it returns HTML, Access is
on the hostname and needs removing.
