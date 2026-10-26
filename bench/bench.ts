/**
 * Performance gates (M0 index, M1 blame incl. D11). Runs the real bundled worker against the generated fixtures.
 *   pnpm bench          local budgets
 *   pnpm bench --ci     budgets × CI_SLACK (shared CI runners are slower and noisier)
 *   --report-only       print budget misses without failing (macOS/Windows CI runners, PLAN.md D15)
 */
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import * as path from 'node:path';
import { WorkerPool } from '@gvx/git-engine';

const ROOT = path.resolve(__dirname, '..');
const BIG = path.join(ROOT, 'test/fixtures/repos/big-100k');
const LARGE = path.join(ROOT, 'test/fixtures/repos/large-files');
const WIDE = path.join(ROOT, 'test/fixtures/repos/wide-100k');
const WORKER = path.join(ROOT, 'dist/worker.js');
const CI = process.argv.includes('--ci');
const CI_SLACK = 2;
const REPORT_ONLY = process.argv.includes('--report-only');
export const CALIBRATION_GIT = 'calibration: git log of 100k commits';
export const CALIBRATION_CPU = 'calibration: JS parse/sort/map, 200k rows';

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
  record(name, samples, budgetMs);
}

function record(name: string, samples: number[], budgetMs?: number): void {
  samples = samples.map((x) => Math.round(x * 10) / 10);
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

    // Calibrations: workloads independent of our code, timed on the same runner. The regression gate
    // (bench/compare.mjs) divides each measure by one of them, so a slow or fast CI machine cancels out.
    await measure(CALIBRATION_GIT, 5, async () => {
      await new Promise<void>((resolve, reject) =>
        execFile('git', ['log', '--all', '--format=%H %P %an %s'], { cwd: BIG, maxBuffer: 1 << 28 }, (e) => (e ? reject(e) : resolve())),
      );
    });
    await measure(CALIBRATION_CPU, 5, async () => {
      // Allocation, string work, sorting and Map lookups: the mix our parsers and layout do.
      const rows: string[] = [];
      for (let i = 0; i < 200_000; i++) rows.push(`${(i * 2654435761) >>> 0} ${i % 97} subject number ${i}`);
      const parsed = rows.map((r) => r.split(' '));
      const m = new Map<string, number>();
      for (const p of parsed) m.set(p[0]!, Number(p[1]));
      const nums = Float64Array.from(m.values());
      nums.sort();
      if (nums.length !== m.size) throw new Error('calibration');
    });

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

    // Only the two syncs are timed: the git plumbing that sets up each step spawns processes, and
    // process start-up on Windows runners is slow and erratic enough to fail the budget on its own.
    const incremental: number[] = [];
    for (let i = 0; i < 5; i++) {
      const c = git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'bench');
      git('update-ref', 'refs/heads/bench-tmp', c);
      let t = performance.now();
      const a = await pool.request('index.sync', { root, storageDir: storage('warm') }, { affinity: root });
      let ms = performance.now() - t;
      git('update-ref', '-d', 'refs/heads/bench-tmp');
      t = performance.now();
      const b = await pool.request('index.sync', { root, storageDir: storage('warm') }, { affinity: root });
      ms += performance.now() - t;
      if (a.mode !== 'incremental' || b.mode !== 'incremental' || b.commitCount !== 100_000) {
        throw new Error(`unexpected ${a.mode}/${b.mode}/${b.commitCount}`);
      }
      incremental.push(ms);
    }
    record('index: incremental, +1 commit then branch delete', incremental, 600);

    pool.dispose();

    // ---- Graph (M2): lane layout and viewport pages, index already loaded from disk ----
    const PAGE = 100;
    const graphSession = async () => {
      const p = newPool();
      await p.request('index.sync', { root, storageDir: storage('warm') }, { affinity: root });
      return p;
    };
    const firstPage: number[] = [];
    const fullLayout: number[] = [];
    let width = 0;
    for (let i = 0; i < 3; i++) {
      const p = await graphSession();
      let t = performance.now();
      await p.request('graph.page', { root, start: 0, count: PAGE }, { affinity: root });
      firstPage.push(performance.now() - t);
      t = performance.now();
      const last = await p.request('graph.page', { root, start: 100_000 - PAGE, count: PAGE }, { affinity: root });
      fullLayout.push(performance.now() - t);
      width = last.width;
      p.dispose();
    }
    record('graph: first page, cold (lays out all 100k rows)', firstPage, 100);
    record(`graph: last page, already laid out (${width} lanes)`, fullLayout, 16);
    const scrollPool = await graphSession();
    await scrollPool.request('graph.page', { root, start: 100_000 - PAGE, count: PAGE }, { affinity: root });
    await measure('graph: page of 100 laid-out rows (scrolling)', 20, async (i) => {
      const pg = await scrollPool.request('graph.page', { root, start: (i * 4919) % 99_900, count: PAGE }, { affinity: root });
      if (pg.commits.length !== PAGE) throw new Error(`expected ${PAGE} rows, got ${pg.commits.length}`);
    }, 16);

    // Filters and search (task 8): a view is built once per index/HEAD, then paged like the full graph.
    await measure('graph: current-branch view, first page (builds the view)', 1, async () => {
      await scrollPool.request('graph.page', { root, view: { kind: 'branch' }, start: 0, count: PAGE }, { affinity: root });
    }, 500);
    await measure('graph: file view src/hot.ts (5k commits), first page (git log + build)', 1, async () => {
      const p = await scrollPool.request('graph.page', { root, view: { kind: 'file', path: 'src/hot.ts' }, start: 0, count: PAGE }, { affinity: root });
      if (p.total < 4000) throw new Error(`expected ~5k commits touching src/hot.ts, got ${p.total}`);
    });
    await measure('graph: search 100k subjects/authors (text)', 5, async () => {
      const r = await scrollPool.request('graph.search', { root, query: 'module 7' }, { affinity: root });
      if (!r.rows.length) throw new Error('expected matches');
    }, 100);
    scrollPool.dispose();

    // Same on wide-100k: 24 branches worked on in parallel, so many lanes cross every row.
    const wideRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: WIDE, encoding: 'utf8' }).trim();
    const widePool = newPool();
    await widePool.request('index.sync', { root: wideRoot, storageDir: storage('wide') }, { affinity: wideRoot });
    let wideWidth = 0;
    let wideEdges = 0;
    await measure('graph wide: first page, cold (lays out all 100k rows)', 1, async () => {
      wideWidth = (await widePool.request('graph.page', { root: wideRoot, start: 0, count: PAGE }, { affinity: wideRoot })).width;
    }, 100);
    console.log(`  (wide: ${wideWidth} lanes)`);
    await measure('graph wide: page of 100 laid-out rows (scrolling)', 20, async (i) => {
      const pg = await widePool.request('graph.page', { root: wideRoot, start: (i * 4919) % 99_900, count: PAGE }, { affinity: wideRoot });
      wideEdges = Math.max(wideEdges, pg.edges.length);
    }, 16);
    console.log(`  (wide: up to ${wideEdges} edges per 100-row page)`);
    widePool.dispose();

    // ---- Blame (M1; D10 prefetch, D11 streaming + disk cache + Bloom filters) ----
    // Each cold sample uses a fresh pool whose blame worker is already warm (as after repo open),
    // so samples measure git, not worker startup, and nothing is cached.
    const blameWorkerPool = async () => {
      const p = newPool();
      await p.request('blame.warm', { root }, { affinity: root });
      return p;
    };
    /** Request → the moment `line` (0-based) is attributed by streamed progress, and → complete. */
    const timeToLine = async (p: WorkerPool, file: string, line: number, storageDir?: string, at = root) => {
      const t = performance.now();
      let lineMs: number | null = null;
      await p.request('blame.file', { root: at, path: file, storageDir }, {
        affinity: at,
        onPartial: (pr) => {
          for (let i = 0; lineMs === null && i < pr.ranges.length; i += 5) {
            if (line >= pr.ranges[i]! && line < pr.ranges[i]! + pr.ranges[i + 1]!) lineMs = performance.now() - t;
          }
        },
      });
      const total = performance.now() - t;
      return { line: lineMs ?? total, total };
    };

    // In src/hot.ts (4,992 commits), lines 0, 20, …, 180 changed within the last 200 commits;
    // the others are unchanged since the first commit.
    const RECENT_LINE = 0;
    const OLDEST_LINE = 1;
    const recent: number[] = [];
    const oldest: number[] = [];
    const whole: number[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await blameWorkerPool();
      recent.push((await timeToLine(p, 'src/hot.ts', RECENT_LINE)).line);
      p.dispose();
      const q = await blameWorkerPool();
      const r = await timeToLine(q, 'src/hot.ts', OLDEST_LINE);
      oldest.push(r.line);
      whole.push(r.total);
      q.dispose();
    }
    record('blame cold: recently changed line shown (streamed)', recent, 50);
    record('blame cold: line unchanged since first commit (documented)', oldest);
    record('blame cold: src/hot.ts complete (documented)', whole);

    // Only files changed on the main line in the last 2,000 commits. A few module files are changed only
    // on side branches whose changes the merges drop, so they keep their first-commit content and blame
    // walks all 100k commits (the documented "unchanged since first commit" case, ~0.9 s).
    const recentlyChanged = new Set(git('log', '--first-parent', '-n', '2000', '--format=', '--name-only').split('\n'));
    const tracked = git('ls-tree', '-r', '--name-only', 'HEAD', 'src/')
      .split('\n')
      .filter((f) => /\/f\d+\.ts$/.test(f) && recentlyChanged.has(f));
    if (tracked.length < 40) throw new Error(`expected >= 40 module files in the fixture, found ${tracked.length}`);
    const files = tracked.filter((_, i) => i % 2 === 0).slice(0, 20);
    const others = tracked.filter((_, i) => i % 2 === 1).slice(0, 20);
    const blamePool = await blameWorkerPool();
    await measure('blame cold: recently rewritten files, whole file', files.length, async (i) => {
      const b = await blamePool.request('blame.file', { root, path: files[i]! }, { affinity: root });
      if (b.cacheHit) throw new Error('expected a cold blame');
    }, 50);
    await measure('blame: repeat request (memory, no git process)', 10, async () => {
      const b = await blamePool.request('blame.file', { root, path: files[0]! }, { affinity: root });
      if (b.source !== 'memory') throw new Error(`expected memory, got ${b.source}`);
    }, 16);
    blamePool.dispose();

    const busyPool = await blameWorkerPool();
    const indexing = busyPool.request('index.sync', { root, storageDir: storage('busy'), full: true }, { affinity: root });
    await measure('blame cold: same, during a full 100k index load', others.length, async (i) => {
      await busyPool.request('blame.file', { root, path: others[i]! }, { affinity: root });
    }, 50);
    await indexing;
    busyPool.dispose();

    // D11c: a file blamed in an earlier session comes back from disk.
    const blameStore = storage('blame-store');
    const first = await blameWorkerPool();
    await timeToLine(first, 'src/hot.ts', OLDEST_LINE, blameStore);
    await new Promise((r) => setTimeout(r, 300)); // the disk write is fire-and-forget: let it land
    first.dispose();
    const fromDisk: number[] = [];
    for (let i = 0; i < 20; i++) {
      const p = await blameWorkerPool();
      const t = performance.now();
      const b = await p.request('blame.file', { root, path: 'src/hot.ts', storageDir: blameStore }, { affinity: root });
      fromDisk.push(performance.now() - t);
      if (b.source !== 'disk') throw new Error(`expected disk, got ${b.source}`);
      p.dispose();
    }
    record('blame: src/hot.ts in a new session (disk cache)', fromDisk, 50);

    // D11b: the same worst case after `git commit-graph write --reachable --changed-paths`, on a copy.
    const bloomRepo = path.join(scratch, 'bloom-repo');
    cpSync(BIG, bloomRepo, { recursive: true });
    const bloomRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: bloomRepo, encoding: 'utf8' }).trim();
    const graphPool = newPool();
    const written = await graphPool.request('repo.writeCommitGraph', { root: bloomRoot }, { affinity: bloomRoot });
    graphPool.dispose();
    record('commit-graph write with Bloom filters, 100k commits (documented)', [written.durationMs]);
    const bloomOldest: number[] = [];
    for (let i = 0; i < 3; i++) {
      const p = newPool();
      await p.request('blame.warm', { root: bloomRoot }, { affinity: bloomRoot });
      bloomOldest.push((await timeToLine(p, 'src/hot.ts', OLDEST_LINE, undefined, bloomRoot)).line);
      p.dispose();
    }
    record('blame cold: line unchanged since first commit, with Bloom (documented)', bloomOldest);

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
    milestones: ['M0', 'M1', 'M2'],
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
    if (!REPORT_ONLY) process.exit(1);
    console.log('(report only: not failing)');
    return;
  }
  console.log('all budgets met');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
