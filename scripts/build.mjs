// Bundles the extension host and the git worker as separate CommonJS files.
import * as esbuild from 'esbuild';

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

const targets = [
  { ...common, entryPoints: ['packages/host/src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...common, entryPoints: ['packages/git-engine/src/worker.ts'], outfile: 'dist/worker.js' },
];

if (watch) {
  for (const t of targets) await (await esbuild.context(t)).watch();
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
}
