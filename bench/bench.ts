/**
 * Performance gates (M0 index, M1 blame). Runs the real bundled worker against the generated fixtures.
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
const LARGE = path.join(ROOT, 'test/fixtures/repos/large-files');
const WORKER = path.join(ROOT, 'dist/worker.js');
const CI = process.argv.includes('--ci');
const CI_SLACK = 2;

interface Result {
  name: string;
  samples: number[];
  budgetMs?: number;
}
const results: Result[] = [];

async function measure(name: string, runs: number, fn: (i: number) => Promise<void>, budgetMs?: number): Promise<void> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn(i);
    samples.push(Math.round((performance.now() - t) * 10) / 10);
  }
  results.push({ name, samples, budgetMs });
  console.log(
    `${name.padEnd(54)} median ${median(samples).toFixed(1).padStart(7)} ms  p95 ${p95(samples).toFixed(1).padStart(7)} ms` +
      (budgetMs ? `  budget ${budgetMs * (CI ? CI_SLACK : 1)} ms (p95)` : ''),
  );
}
/** Nearest-rank p95 (the max for fewer than 20 samples). */
const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.ceil(a.length * 0.95) - 1]!;
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

    // M1 (D10): first-ever blame of files with <= 1,000 commits of history, measured from request
    // to result, in a fresh pool (no worker-side cache). 20 distinct files, 500 commits each.
    const tracked = git('ls-tree', '-r', '--name-only', 'HEAD', 'src/').split('\n').filter((f) => /\/f\d+\.ts$/.test(f));
    if (tracked.length < 40) throw new Error(`expected >= 40 module files in the fixture, found ${tracked.length}`);
    const files = tracked.filter((_, i) => i % 2 === 0).slice(0, 20);
    const blamePool = newPool();
    await blamePool.request('blame.file', { root, path: 'src/m1/f1.ts' }, { affinity: root }); // spawn the blame worker
    await measure('blame cold: 500-commit files, idle', files.length, async (i) => {
      const b = await blamePool.request('blame.file', { root, path: files[i]! }, { affinity: root });
      if (b.cacheHit) throw new Error('expected a cold blame');
    }, 50);
    blamePool.dispose();

    const busyPool = newPool();
    await busyPool.request('blame.file', { root, path: 'src/m1/f1.ts' }, { affinity: root });
    const indexing = busyPool.request('index.sync', { root, storageDir: storage('busy'), full: true }, { affinity: root });
    const others = tracked.filter((_, i) => i % 2 === 1).slice(0, 20);
    await measure('blame cold: 500-commit files, during a 100k index load', others.length, async (i) => {
      await busyPool.request('blame.file', { root, path: others[i]! }, { affinity: root });
    }, 50);
    await indexing;
    busyPool.dispose();

    const worstPool = newPool();
    await worstPool.request('blame.file', { root, path: 'src/m1/f1.ts' }, { affinity: root });
    await measure('blame cold: src/hot.ts, 4,992 commits (documented worst case)', 1, async () => {
      await worstPool.request('blame.file', { root, path: 'src/hot.ts' }, { affinity: root });
    });
    worstPool.dispose();

    const largeRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: LARGE, encoding: 'utf8' }).trim();
    const remapPool = newPool();
    const big = await remapPool.request('blame.file', { root: largeRoot, path: 'big.txt', force: true }, { affinity: largeRoot });
    const text = Array.from({ length: 20_001 }, (_, i) => (i === 15_000 ? 'typed here' : `row ${i}${i === 10 ? ' edited' : ''}`)).join('\n') + '\n';
    await measure('remap: 20k-line buffer with one edit (round trip)', 10, async () => {
      const { map } = await remapPool.request('blame.remap', { root: largeRoot, blobSha: big.blobSha!, text }, { affinity: largeRoot });
      if (!map || map[15_000] !== -1) throw new Error('unexpected remap');
    }, 50);
    remapPool.dispose();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const failures = results.filter((r) => r.budgetMs && p95(r.samples) > r.budgetMs * (CI ? CI_SLACK : 1));
  const out = {
    milestones: ['M0', 'M1'],
    date: new Date().toISOString(),
    machine: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, cores: cpus().length, node: process.version, git: git('--version') },
    ci: CI,
    results,
  };
  const file = path.join(ROOT, 'bench/results', CI ? `${process.platform}.ci.json` : 'results.local.json');
  mkdirSync(path.dirname(file), { recursive: true });
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
