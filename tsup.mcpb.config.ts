import { defineConfig } from 'tsup';

// Build for the MCPB bundle ONLY — not for npm.
//
// The npm build (tsup.config.ts) leaves dependencies external, which is correct
// there: npm resolves them at install time and users get dedup/patching for free.
//
// An MCPB bundle has no install step — the host unzips it and runs the entry
// point, so every dependency has to be inside the archive. Shipping node_modules
// works but costs ~24 MB, most of it the MCP SDK's HTTP-server transitive deps
// (hono, ajv, jose, qs) that a stdio server never loads.
//
// So bundle everything into one tree-shaken file instead. Same source, same
// behaviour, a fraction of the size, and nothing to resolve at runtime.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  outDir: 'dist-mcpb',
  clean: true,
  noExternal: [/.*/], // inline every dependency
  treeshake: true,
  minify: false, // keep it auditable — reviewers should be able to read it
  // As in the npm build: no `banner`. The shebang already at the top of
  // src/index.ts is preserved by esbuild; adding one emits a second shebang
  // on line 2, which is a hard syntax error.
});
