/**
 * M0 performance gate. Runs the real bundled worker against the generated fixtures.
 *   pnpm bench          local budgets
 *   pnpm bench --ci     budgets × CI_SLACK (shared CI runners are slower and noisier)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import * as path from 'node:path';
import { WorkerPool } from '@gvx/git-engine';

const ROOT = path.resolve(__dirname, '..');
const BIG = path.join(ROOT, 'test/fixtures/repos/big-100k');
const WORKER = path.join(ROOT, 'dist/worker.js');
const CI = process.argv.includes('--ci');
const CI_SLACK = 2;

interface Result {
  name: string;
  samples: number[];
  budgetMs?: number;
}
const results: Result[] = [];

async function measure(name: string, runs: number, fn: () => Promise<void>, budgetMs?: number): Promise<void> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    samples.push(Math.round((performance.now() - t) * 10) / 10);
  }
  results.push({ name, samples, budgetMs });
  const worst = Math.max(...samples);
  console.log(`${name.padEnd(42)} median ${median(samples).toFixed(1).padStart(8)} ms  worst ${worst.toFixed(1).padStart(8)} ms${budgetMs ? `  budget ${budgetMs * (CI ? CI_SLACK : 1)} ms` : ''}`);
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
const git = (...args: string[]) => execFileSync('git', args, { cwd: BIG, encoding: 'utf8' }).trim();
const newPool = () => new WorkerPool({ workerPath: WORKER, gitPath: 'git' });

async function main() {
  const root = git('rev-parse', '--show-toplevel');
  const scratch = mkdtempSync(path.join(tmpdir(), 'gvx-bench-'));
  const storage = (n: string) => path.join(scratch, n);
  try {
    // Untimed warm-up: page the fixture into the OS file cache so the first sample is not an outlier.
    const warm = newPool();
    await warm.request('index.sync', { root, storageDir: storage('warmup') }, { affinity: root });
    warm.dispose();

    await measure('worker spawn + first request', 3, async () => {
      const p = newPool();
      await p.request('repo.resolve', { path: root });
      p.dispose();
    });

    await measure('index: cold full load, 100k commits', 3, async () => {
      const p = newPool();
      const dir = storage(`cold-${Math.random()}`);
      const s = await p.request('index.sync', { root, storageDir: dir }, { affinity: root });
      if (s.mode !== 'full' || s.commitCount !== 100_000) throw new Error(`unexpected ${JSON.stringify(s)}`);
      p.dispose();
    }, 2000);

    mkdirSync(storage('warm'));
    const warmPool = newPool();
    await warmPool.request('index.sync', { root, storageDir: storage('warm') }, { affinity: root });
    warmPool.dispose();
    await measure('index: open from disk (new session)', 3, async () => {
      const p = newPool();
      const s = await p.request('index.sync', { root, storageDir: storage('warm') }, { affinity: root });
      if (s.mode !== 'cached') throw new Error(`expected cached, got ${s.mode}`);
      p.dispose();
    }, 500);

    const pool = newPool();
    await pool.request('index.sync', { root, storageDir: storage('warm') }, { affinity: root });
    await measure('index: re-sync, refs unchanged', 5, async () => {
      await pool.request('index.sync', { root, storageDir: storage('warm') }, { affinity: root });
    }, 100);

    await measure('index: incremental, +1 commit then branch delete', 3, async () => {
      const c = git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'bench');
      git('update-ref', 'refs/heads/bench-tmp', c);
      const a = await pool.request('index.sync', { root, storageDir: storage('warm') }, { affinity: root });
      git('update-ref', '-d', 'refs/heads/bench-tmp');
      const b = await pool.request('index.sync', { root, storageDir: storage('warm') }, { affinity: root });
      if (a.mode !== 'incremental' || b.mode !== 'incremental' || b.commitCount !== 100_000) {
        throw new Error(`unexpected ${a.mode}/${b.mode}/${b.commitCount}`);
      }
    }, 600);

    let first = true;
    await measure('blame: src/hot.ts cold (5k-commit file)', 1, async () => {
      const b = await pool.request('blame.file', { root, path: 'src/hot.ts' }, { affinity: root });
      if (b.cacheHit || !first) throw new Error('expected a cache miss');
      first = false;
    });
    await measure('blame: src/hot.ts cached', 10, async () => {
      const b = await pool.request('blame.file', { root, path: 'src/hot.ts' }, { affinity: root });
      if (!b.cacheHit) throw new Error('expected a cache hit');
    });
    pool.dispose();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const failures = results.filter((r) => r.budgetMs && Math.max(...r.samples) > r.budgetMs * (CI ? CI_SLACK : 1));
  const out = {
    milestone: 'M0',
    date: new Date().toISOString(),
    machine: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, cores: cpus().length, node: process.version, git: git('--version') },
    ci: CI,
    results,
  };
  const file = path.join(ROOT, 'bench/results', CI ? `m0-${process.platform}.ci.json` : 'm0.local.json');
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(ROOT, file)}`);
  if (failures.length) {
    console.error(`\nBUDGET MISSED: ${failures.map((f) => f.name).join('; ')}`);
    process.exit(1);
  }
  console.log('all budgets met');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
