// Builds the production bundles and bench/bench.ts, makes sure the fixtures exist, then runs the benchmark.
// Run it with `node bench/run.mjs` on macOS: under a live pnpm process, child processes (git) start
// ~25 ms slower there for reasons not yet understood, which inflates every git-bound number.
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';

const pass = process.argv.slice(2);
const step = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
step(process.execPath, ['scripts/build.mjs', '--production']);
step(process.execPath, ['scripts/fixtures.mjs', '--only', 'big-100k,large-files,wide-100k']);
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
