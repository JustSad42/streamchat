// Bundles the server into one CommonJS file (dist/server.cjs) for the desktop app.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/server.cjs',
  legalComments: 'none',
  logLevel: 'warning',
  define: { 'import.meta.dirname': '__dirname' },
});
console.log('bundled dist/server.cjs');
