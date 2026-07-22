#!/usr/bin/env python3
"""Mutation-test the HTTP transport.

A test that never fails proves nothing. This reintroduces each bug the tests
claim to catch and asserts the suite goes red. Any SURVIVED line is a test that
would not have stopped that bug reaching production.

Run from the package root.
"""
import shutil
import subprocess
import sys
import pathlib

SRC = pathlib.Path('src/http.ts')
BACKUP = pathlib.Path('.http.ts.pristine')   # scratch copy, git-ignored

# (label, find, replace, which test must catch it)
MUTATIONS = [
    ("M1  callerKey falls back to the operator's env key",
     "  return '';\n}",
     "  return (process.env.LIVETENNISAPI_KEY ?? '').trim();\n}",
     'test/http-isolation.mjs'),

    ("M2  limiter keyed on IP only (one global bucket behind the tunnel)",
     "  const key = callerKey(req);\n"
     "  if (key) return `k:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;\n",
     "",
     'test/http-ratelimit.mjs'),

    ("M3  flat limit, no higher ceiling for authenticated callers",
     "limit: (req: Request) => (callerKey(req) ? KEYED_LIMIT : ANON_LIMIT),",
     "limit: ANON_LIMIT,",
     'test/http-ratelimit.mjs'),

    ("M4  limiter removed from the route entirely",
     "app.post('/mcp', limiter, async",
     "app.post('/mcp', async",
     'test/http-ratelimit.mjs'),

    ("M5  /health placed behind the limiter (monitoring blinded under load)",
     "app.get('/health', (_req, res) => {",
     "app.get('/health', limiter, (_req, res) => {",
     'test/http-ratelimit.mjs'),

    ("M6  anon and keyed limits swapped",
     "limit: (req: Request) => (callerKey(req) ? KEYED_LIMIT : ANON_LIMIT),",
     "limit: (req: Request) => (callerKey(req) ? ANON_LIMIT : KEYED_LIMIT),",
     'test/http-ratelimit.mjs'),

    ("M7  stateless transport given session ids (server reuse across callers)",
     "new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })",
     "new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })",
     'test/http-isolation.mjs'),

    ("M8  429 answered as plain text, not JSON-RPC",
     "    res.status(429).json({\n"
     "      jsonrpc: '2.0',\n"
     "      error: { code: -32000, message: 'Rate limit exceeded. Retry shortly, or send an API key for a higher limit.' },\n"
     "      id: null,\n"
     "    }),",
     "    res.status(429).send('Too many requests'),",
     'test/http-ratelimit.mjs'),
]


def sh(cmd, timeout=90):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)


def clear_ports():
    out = sh("ss -lntp 2>/dev/null | grep -oP ':812[0-9].*pid=\\K[0-9]+' | sort -u").stdout.split()
    for pid in out:
        sh(f"kill -9 {pid}")


def run_suite(test):
    clear_ports()
    if sh("npm run build", timeout=180).returncode != 0:
        return None, 'BUILD FAILED'
    try:
        r = sh(f"node {test}", timeout=90)
    except subprocess.TimeoutExpired:
        clear_ports()
        return 1, 'TIMED OUT (counts as caught, but the test should fail fast)'
    clear_ports()
    return r.returncode, (r.stdout + r.stderr).strip().splitlines()[-1] if (r.stdout + r.stderr).strip() else ''


def main():
    shutil.copy(SRC, BACKUP)
    print('=== baseline: both suites must pass on the clean build ===')
    for t in ('test/http-isolation.mjs', 'test/http-ratelimit.mjs'):
        code, last = run_suite(t)
        print(f'  {"PASS" if code == 0 else "FAIL"}  {t}: {last}')
        if code != 0:
            print('baseline is not green — aborting'); shutil.copy(BACKUP, SRC); return 1

    print('\n=== mutations (every one must be KILLED) ===')
    survived = []
    for label, find, repl, test in MUTATIONS:
        shutil.copy(BACKUP, SRC)
        s = SRC.read_text()
        if find not in s:
            print(f'  SKIP      {label}  <- pattern not found, mutation is stale')
            survived.append(label + ' (stale pattern)')
            continue
        SRC.write_text(s.replace(find, repl, 1))
        code, last = run_suite(test)
        if code == 0:
            print(f'  SURVIVED  {label}\n              {test} still passed: {last}')
            survived.append(label)
        else:
            print(f'  KILLED    {label}')

    shutil.copy(BACKUP, SRC)
    sh("npm run build", timeout=180)
    print('\n=== restored; reverifying clean build ===')
    ok = True
    for t in ('test/http-isolation.mjs', 'test/http-ratelimit.mjs'):
        code, last = run_suite(t)
        print(f'  {"PASS" if code == 0 else "FAIL"}  {t}: {last}')
        ok &= code == 0

    print()
    if survived:
        print(f'{len(survived)}/{len(MUTATIONS)} MUTATIONS SURVIVED — these bugs would ship undetected:')
        for s in survived:
            print('  -', s)
        return 1
    print(f'all {len(MUTATIONS)} mutations killed; clean build {"green" if ok else "RED"}')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
