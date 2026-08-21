import { build } from 'esbuild';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(__dirname, 'server', 'server.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(__dirname, 'server.bundle.cjs'),
  external: ['electron'],
  minify: false,
  logLevel: 'info',
  // Let esbuild inject __dirname correctly - don't fake import.meta.url
  // Instead we inject a banner that sets __dir from __dirname
  banner: {
    js: '/* Nullmesh server bundle */',
  },
});

console.log('Bundle complete: server.bundle.cjs');
