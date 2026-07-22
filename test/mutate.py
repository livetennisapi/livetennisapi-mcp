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

SOURCES = [pathlib.Path('src/http.ts'), pathlib.Path('src/server.ts')]
BACKUP_DIR = pathlib.Path('.mutation-pristine')   # scratch copies, git-ignored

# (label, file, find, replace, which test must catch it)
MUTATIONS = [
    ("M1  callerKey falls back to the operator's env key",
     'src/http.ts',
     "  return '';\n}",
     "  return (process.env.LIVETENNISAPI_KEY ?? '').trim();\n}",
     'test/http-isolation.mjs'),

    ("M2  limiter keyed on IP only (one global bucket behind the tunnel)",
     'src/http.ts',
     "  const key = callerKey(req);\n"
     "  if (key) return `k:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;\n",
     "",
     'test/http-ratelimit.mjs'),

    ("M3  flat limit, no higher ceiling for authenticated callers",
     'src/http.ts',
     "limit: (req: Request) => (callerKey(req) ? KEYED_LIMIT : ANON_LIMIT),",
     "limit: ANON_LIMIT,",
     'test/http-ratelimit.mjs'),

    ("M4  limiter removed from the route entirely",
     'src/http.ts',
     "app.post('/mcp', limiter, async",
     "app.post('/mcp', async",
     'test/http-ratelimit.mjs'),

    ("M5  /health placed behind the limiter (monitoring blinded under load)",
     'src/http.ts',
     "app.get('/health', (_req, res) => {",
     "app.get('/health', limiter, (_req, res) => {",
     'test/http-ratelimit.mjs'),

    ("M6  anon and keyed limits swapped",
     'src/http.ts',
     "limit: (req: Request) => (callerKey(req) ? KEYED_LIMIT : ANON_LIMIT),",
     "limit: (req: Request) => (callerKey(req) ? ANON_LIMIT : KEYED_LIMIT),",
     'test/http-ratelimit.mjs'),

    ("M7  stateless transport given session ids (server reuse across callers)",
     'src/http.ts',
     "new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })",
     "new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })",
     'test/http-isolation.mjs'),

    ("M8  429 answered as plain text, not JSON-RPC",
     'src/http.ts',
     "    res.status(429).json({\n"
     "      jsonrpc: '2.0',\n"
     "      error: { code: -32000, message: 'Rate limit exceeded. Retry shortly, or send an API key for a higher limit.' },\n"
     "      id: null,\n"
     "    }),",
     "    res.status(429).send('Too many requests'),",
     'test/http-ratelimit.mjs'),
    ("M9  outputSchema dropped from every tool",
     'src/server.ts',
     "      outputSchema: {\n        ok: okField,",
     "      _outputSchema: {\n        ok: okField,",
     'test/tools-output.mjs'),

    ("M10 annotations dropped (readOnlyHint no longer advertised)",
     'src/server.ts',
     "      annotations: READ_ONLY,",
     "",
     'test/tools-output.mjs'),

    ("M11 guard's no-key path omits structuredContent (SDK throws)",
     'src/server.ts',
     "  const fail = (message: string): ToolResult => ({\n"
     "    content: [{ type: 'text', text: message }],\n"
     "    structuredContent: { ok: false, message },\n"
     "  });",
     "  const fail = (message: string): ToolResult => ({\n"
     "    content: [{ type: 'text', text: message }],\n"
     "  });",
     'test/tools-output.mjs'),

    ("M12 a parameter loses its description",
     'src/server.ts',
     "    .describe('Match id, as returned by get_live_matches, get_upcoming_matches or get_recent_results.');",
     ";",
     'test/tools-output.mjs'),

    ("M13 structuredContent.message diverges from the text content",
     'src/server.ts',
     "        structuredContent: { ok: true, message: body, ...(data ?? {}) },",
     "        structuredContent: { ok: true, message: 'ok', ...(data ?? {}) },",
     'test/tools-output.mjs'),
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


def restore_all():
    for src in SOURCES:
        shutil.copy(BACKUP_DIR / src.name, src)


def main():
    BACKUP_DIR.mkdir(exist_ok=True)
    for src in SOURCES:
        shutil.copy(src, BACKUP_DIR / src.name)
    print('=== baseline: both suites must pass on the clean build ===')
    for t in ('test/http-isolation.mjs', 'test/http-ratelimit.mjs', 'test/tools-output.mjs'):
        code, last = run_suite(t)
        print(f'  {"PASS" if code == 0 else "FAIL"}  {t}: {last}')
        if code != 0:
            print('baseline is not green — aborting'); restore_all(); return 1

    print('\n=== mutations (every one must be KILLED) ===')
    survived = []
    for label, path, find, repl, test in MUTATIONS:
        restore_all()
        SRC = pathlib.Path(path)
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

    restore_all()
    sh("npm run build", timeout=180)
    print('\n=== restored; reverifying clean build ===')
    ok = True
    for t in ('test/http-isolation.mjs', 'test/http-ratelimit.mjs', 'test/tools-output.mjs'):
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
