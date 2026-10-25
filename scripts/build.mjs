// Bundles the extension host and the git worker as separate CommonJS files (esbuild), and each
// webview as one ES module + stylesheet under dist/webviews/<name>/ (Vite).
import { rmSync } from 'node:fs';
import * as esbuild from 'esbuild';
import { build as vite } from 'vite';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  define: { __DEV__: JSON.stringify(!production) },
  logLevel: 'info',
};

// Production output must not carry stale dev files (source maps) into the VSIX.
if (production) rmSync('dist', { recursive: true, force: true });

const targets = [
  { ...common, entryPoints: ['packages/host/src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...common, entryPoints: ['packages/git-engine/src/worker.ts'], outfile: 'dist/worker.js' },
];

const webviews = ['packages/webview-graph/vite.config.ts'];
const viteBuild = (configFile) =>
  vite({ configFile, mode: production ? 'production' : 'development', logLevel: 'warn', build: watch ? { watch: {} } : {} });

if (watch) {
  for (const t of targets) await (await esbuild.context(t)).watch();
  for (const w of webviews) await viteBuild(w);
} else {
  await Promise.all([...targets.map((t) => esbuild.build(t)), ...webviews.map(viteBuild)]);
}
