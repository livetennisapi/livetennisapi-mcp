import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  clean: true,
  // No `banner` here on purpose: esbuild preserves the shebang already present
  // at the top of src/index.ts. Adding one emits a SECOND shebang on line 2,
  // which is a hard syntax error — and this package is executed directly as
  // `npx livetennisapi-mcp`, so that breaks every user.
});
