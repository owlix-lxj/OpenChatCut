import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const viteRawImports = {
  name: 'vite-raw-imports',
  setup(bundler) {
    bundler.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)),
      namespace: 'vite-raw',
    }));
    bundler.onLoad({ filter: /.*/, namespace: 'vite-raw' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

await build({
  entryPoints: ['server/standalone.ts', 'src/plugins/resourcePreview.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  entryNames: '[name]',
  outExtension: { '.js': '.mjs' },
  outdir: 'server-dist',
  plugins: [viteRawImports],
});
