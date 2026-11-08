import { defineConfig } from 'tsup';

export default defineConfig({
  // auth.ts is an entry of its own so test/auth.mjs can import the parser
  // directly; http.js still inlines or chunk-imports it as tsup sees fit.
  entry: ['src/index.ts', 'src/http.ts', 'src/auth.ts'],
  format: ['esm'],
  target: 'es2022',
  clean: true,
  // No `banner` here on purpose: esbuild preserves the shebang already present
  // at the top of src/index.ts. Adding one emits a SECOND shebang on line 2,
  // which is a hard syntax error — and this package is executed directly as
  // `npx livetennisapi-mcp`, so that breaks every user.
});
