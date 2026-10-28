/**
 * Module resolve hook for scripts/ai-parity-snapshot.mjs.
 *
 * The livetennisapi-ai tarball imports `ai`, `zod` and `livetennisapi`, none of
 * which exist next to an unpacked tarball. This hook points `ai` at a stub whose
 * `tool()` returns its argument unchanged (which is all the real one does with
 * the fields we read), and the other two at this repo's own copies, so the
 * schemas are built by the same zod instance the server uses.
 */
let map = {};

export async function initialize(data) {
  map = data ?? {};
}

export async function resolve(specifier, context, next) {
  const target = map[specifier];
  if (target) return { url: target, shortCircuit: true };
  return next(specifier, context);
}
