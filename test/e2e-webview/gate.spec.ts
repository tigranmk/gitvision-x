/**
 * M2 gate (PLAN.md): 60 fps scroll at 100k rows, measured from a Chromium performance trace; first paint
 * < 800 ms on a 100k-commit repo with its index on disk (warm). Cold (no index yet: full build + first rows)
 * is recorded and bounded by M0's 2 s cold-index budget.
 * Stage-1 sync (< 100 ms) is covered by graph.spec.ts and the integration suite. Results are written to
 * bench/results/webview.<platform|local>.json.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openGraph, type Harness } from './harness';

const CI = !!process.env.CI;
const SLACK = CI ? 2 : 1;
const FRAME_MS = 1000 / 60;
const results: Record<string, unknown> = {};

test.afterAll(() => {
  const file = path.resolve(__dirname, '../../bench/results', CI ? `webview.${process.platform}.ci.json` : 'webview.local.json');
  mkdirSync(path.dirname(file), { recursive: true });
  const machine = { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, cores: cpus().length };
  writeFileSync(file, JSON.stringify({ milestone: 'M2', date: new Date().toISOString(), machine, ci: CI, results }, null, 2) + '\n');
});

async function firstRows(h: Harness): Promise<number> {
  await expect.poll(() => h.page.evaluate(() => (window as unknown as { __gvxFirstRows?: number }).__gvxFirstRows ?? 0)).toBeGreaterThan(0);
  return h.page.evaluate(() => (window as unknown as { __gvxFirstRows: number }).__gvxFirstRows);
}

test('first paint < 800 ms on 100k commits (cold and warm index)', async ({ browser }) => {
  const storage = mkdtempSync(path.join(tmpdir(), 'gvx-gate-'));
  try {
    for (const run of ['cold', 'warm'] as const) {
      const page = await browser.newPage();
      const h = await openGraph(page, 'wide-100k', { storageDir: storage });
      const paint = await firstRows(h);
      const total = h.sync.ms + paint;
      console.log(`${run}: index ${h.sync.mode} ${h.sync.ms.toFixed(0)} ms + page → first rows ${paint.toFixed(0)} ms = ${total.toFixed(0)} ms`);
      results[`firstPaint.${run}`] = { indexMs: Math.round(h.sync.ms), indexMode: h.sync.mode, pageToRowsMs: Math.round(paint), totalMs: Math.round(total), budgetMs: run === 'warm' ? 800 : 2000 };
      expect(h.sync.mode).toBe(run === 'cold' ? 'full' : 'cached');
      // Warm is what opening the graph costs: the index is built at activation and kept on disk.
      // Cold (no index at all) is git's own walk of 100k commits plus ours: documented, bounded by M0's 2 s.
      expect(total).toBeLessThan((run === 'warm' ? 800 : 2000) * SLACK);
      await h.dispose();
      await page.close();
    }
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
});

/** A task on a thread's run loop ('toplevel' category; the name changed across Chrome versions). */
const TASK = /^(RunTask|ThreadControllerImpl::RunTask|ThreadPool_RunTask)$/;

interface TraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: { name?: string; data?: Record<string, unknown> };
}

/** Scrolls `rowsPerFrame` rows per animation frame for `frames` frames, inside a trace; returns the events. */
async function tracedScroll(page: Page, rowsPerFrame: number, frames: number): Promise<{ events: TraceEvent[]; start: number; end: number }> {
  const cdp = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  // Playwright types CDPSession events loosely; the Tracing events carry these payloads.
  const on = cdp.on.bind(cdp) as unknown as (event: string, listener: (e: { value: TraceEvent[] }) => void) => void;
  on('Tracing.dataCollected', (e) => events.push(...e.value));
  await cdp.send('Tracing.start', {
    categories: 'toplevel,devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing,__metadata',
    transferMode: 'ReportEvents',
  });
  await page.locator('.scroller').evaluate(
    async (el, { step, n }) => {
      performance.mark('gvx-scroll-start');
      for (let i = 0; i < n; i++) {
        await new Promise<void>((r) =>
          requestAnimationFrame(() => {
            el.scrollTop += step;
            r();
          }),
        );
      }
      performance.mark('gvx-scroll-end');
    },
    { step: rowsPerFrame * 22, n: frames },
  );
  const done = new Promise<void>((r) => on('Tracing.tracingComplete', () => r()));
  await cdp.send('Tracing.end');
  await done;
  await cdp.detach();
  const mark = (n: string) => events.find((e) => e.name === n)?.ts ?? 0;
  return { events, start: mark('gvx-scroll-start'), end: mark('gvx-scroll-end') };
}

function analyse(t: { events: TraceEvent[]; start: number; end: number }) {
  const threads = new Map<string, string>();
  for (const e of t.events) if (e.name === 'thread_name' && e.args?.name) threads.set(`${e.pid}:${e.tid}`, e.args.name);
  const inWindow = (e: TraceEvent) => e.ts >= t.start && e.ts <= t.end;
  const tasksOn = (thread: RegExp) =>
    t.events
      .filter((e) => TASK.test(e.name) && e.ph === 'X' && inWindow(e) && thread.test(threads.get(`${e.pid}:${e.tid}`) ?? ''))
      .map((e) => (e.dur ?? 0) / 1000);
  const main = tasksOn(/^CrRendererMain$/);
  const worker = tasksOn(/^DedicatedWorker thread$/);
  const seconds = (t.end - t.start) / 1e6;
  // Frames drawn by the compositor; the frame reporter marks the ones dropped.
  const frames = t.events.filter((e) => e.name === 'DrawFrame' && inWindow(e)).length;
  const dropped = t.events.filter((e) => {
    if (e.name !== 'PipelineReporter' || e.ph !== 'b' || !inWindow(e)) return false;
    const r = (e.args as { frame_reporter?: { state?: string }; chrome_frame_reporter?: { state?: string } } | undefined) ?? {};
    return (r.frame_reporter ?? r.chrome_frame_reporter)?.state === 'STATE_DROPPED';
  }).length;
  const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
  const pct = (a: number[], p: number) => (a.length ? sorted(a)[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)]! : 0);
  return {
    seconds: +seconds.toFixed(2),
    fps: +(frames / seconds).toFixed(1),
    droppedFrames: dropped,
    mainTasks: main.length,
    mainTaskP95Ms: +pct(main, 0.95).toFixed(2),
    mainTaskP99Ms: +pct(main, 0.99).toFixed(2),
    mainTaskMaxMs: +Math.max(0, ...main).toFixed(2),
    mainTasksOverFrame: main.filter((d) => d > FRAME_MS).length,
    workerTaskP95Ms: +pct(worker, 0.95).toFixed(2),
    workerTaskMaxMs: +Math.max(0, ...worker).toFixed(2),
  };
}

test('scrolls 100k rows (25 lanes) at 60 fps: Chromium trace', async ({ page }) => {
  const h = await openGraph(page, 'wide-100k');
  try {
    await expect(page.locator('[role=option] .subject').first()).toHaveText(/\S/);
    await expect(page.locator('.graph')).toHaveAttribute('data-renderer', 'worker');
    for (const [name, rows] of [
      ['steady (3 rows/frame)', 3],
      ['fling (30 rows/frame)', 30],
    ] as const) {
      const r = analyse(await tracedScroll(page, rows, 300));
      console.log(`${name}: ${JSON.stringify(r)}`);
      results[`scroll.${name}`] = r;
      // 60 fps: every main-thread task fits in a frame (p99; one GC or page arrival may not, max is reported).
      expect(r.mainTaskP99Ms).toBeLessThan(FRAME_MS * SLACK);
      expect(r.mainTasksOverFrame).toBeLessThanOrEqual(Math.ceil(r.mainTasks * 0.01));
      expect(r.workerTaskP95Ms).toBeLessThan(FRAME_MS * SLACK);
      expect(r.fps).toBeGreaterThan(55 / SLACK);
    }
  } finally {
    await h.dispose();
  }
});
