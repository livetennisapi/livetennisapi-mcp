/**
 * Parse an `Authorization: Bearer …` header value without a regex.
 *
 * `callerKey` in http.ts used `/^Bearer\s+(.+)$/i`. On a value such as
 * `Bearer` followed by many spaces and a line terminator, `\s+` and `.+` fight
 * over the whitespace run and the engine retries from every split, which is
 * quadratic in the header length (CodeQL js/polynomial-redos). The header is
 * caller-controlled, so this is a single forward scan instead.
 *
 * The result is identical to the regex for every input, including its corners:
 *
 *   - `Bearer` must be followed by at least one whitespace char and then at
 *     least one more char of any kind, otherwise it is not a bearer header and
 *     `null` is returned so the caller can try the other shapes.
 *   - `.` never matched a line terminator, so a terminator anywhere after the
 *     leading whitespace run means "no match" and `null`.
 *   - The captured token was trimmed, so a value that is all whitespace yields
 *     the empty string, not `null`.
 */
export function bearerToken(auth: string): string | null {
  if (auth.length < 8) return null;
  if (auth.slice(0, 6).toUpperCase() !== 'BEARER') return null;
  if (!isSpace(auth, 6)) return null;

  let start = 7;
  while (start < auth.length && isSpace(auth, start)) start += 1;

  if (start === auth.length) {
    // All whitespace after `Bearer`: the regex gave `.+` the last char, which
    // trimmed to nothing — unless that char was a line terminator.
    return isLineTerminator(auth, auth.length - 1) ? null : '';
  }
  for (let i = start; i < auth.length; i += 1) {
    if (isLineTerminator(auth, i)) return null;
  }
  return auth.slice(start).trimEnd();
}

/**
 * `\s` for one character, by char code: the ECMAScript WhiteSpace set plus the
 * four LineTerminators. Char codes rather than a per-character regex so the
 * scan allocates nothing.
 */
function isSpace(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** The four LineTerminators `.` refuses to match. */
function isLineTerminator(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
}
