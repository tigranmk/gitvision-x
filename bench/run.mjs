// Bundles bench/bench.ts, makes sure the big fixture exists, then runs the benchmark.
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';

const pass = process.argv.slice(2);
const step = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
step(process.execPath, ['scripts/fixtures.mjs', '--only', 'big-100k']);
await esbuild.build({
  entryPoints: ['bench/bench.ts'],
  outfile: 'out/bench.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  define: { __DEV__: 'false' },
  logLevel: 'warning',
});
step(process.execPath, ['out/bench.cjs', ...pass]);
