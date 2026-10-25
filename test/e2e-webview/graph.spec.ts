import { expect, test } from '@playwright/test';
import { openGraph, pixelAt, type Harness } from './harness';

let h: Harness | undefined;
test.afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

test('renders commit rows and the graph canvas under the strict CSP', async ({ page }) => {
  h = await openGraph(page, 'wide-100k');
  const rows = page.locator('[role=option]');
  await expect(rows.first().locator('.subject')).toHaveText(/\S/);
  expect(await rows.count()).toBeGreaterThan(20);
  await expect(rows.first().locator('.sha')).toHaveText(/^[0-9a-f]{7}$/);
  // D6: the graph draws in a blob worker on an OffscreenCanvas, allowed by the CSP's worker-src blob:.
  await expect(page.locator('.graph')).toHaveAttribute('data-renderer', 'worker');
  expect(h.cspViolations).toEqual([]);
  await page.screenshot({ path: 'test-results/graph-top.png' });
});

test('jumping to the middle of 100k commits loads that page and cancels nothing it still needs', async ({ page }) => {
  h = await openGraph(page, 'wide-100k');
  await expect(page.locator('[role=option] .subject').first()).toHaveText(/\S/);
  const target = 50_000;
  await page.locator('.scroller').evaluate((el, y) => (el.scrollTop = y), target * 22);
  await expect(page.locator(`#row-${target} .subject`)).toHaveText(/\S/);
  // Rows are absolutely placed inside the sticky viewport: the target row sits at the top.
  const box = await page.locator(`#row-${target}`).boundingBox();
  expect(Math.round(box!.y)).toBe(0);
  const pages = h.requests.filter((r) => r.method === 'graph.page').map((r) => (r.params as { start: number }).start);
  expect(pages).toContain(Math.floor(target / 200) * 200);
  await page.screenshot({ path: 'test-results/graph-middle.png' });
});

test('scrolls 100k rows at 60 fps', async ({ page }) => {
  h = await openGraph(page, 'wide-100k');
  await expect(page.locator('[role=option] .subject').first()).toHaveText(/\S/);
  // Scroll 3 rows per frame for 300 frames (~5 s of steady scrolling) and record frame intervals.
  const r = await page.locator('.scroller').evaluate(async (el) => {
    const intervals: number[] = [];
    const work: number[] = [];
    let last = performance.now();
    for (let i = 0; i < 300; i++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          const t = performance.now();
          el.scrollTop += 66;
          el.dispatchEvent(new Event('scroll'));
          // Work done for this frame: scroll handler, Svelte update and canvas draw (effects flush in a microtask).
          queueMicrotask(() => queueMicrotask(() => work.push(performance.now() - t)));
          intervals.push(t - last);
          last = t;
          resolve();
        }),
      );
    }
    return { intervals: intervals.slice(1), work };
  });
  const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.ceil(a.length * 0.95) - 1]!;
  // D6: how long the worker takes to draw a frame after the main thread posts it (the lanes trail the text by this).
  const latency = await page.evaluate(() => (window as unknown as { __gvxRenderer: { latencies(): number[] } }).__gvxRenderer.latencies());
  console.log(`worker frame latency p95 ${p95(latency).toFixed(2)} ms over ${latency.length} frames`);
  const longFrames = r.intervals.filter((x) => x > 1000 / 50).length;
  console.log(`frame interval p95 ${p95(r.intervals).toFixed(1)} ms, work p95 ${p95(r.work).toFixed(2)} ms, frames > 20 ms: ${longFrames}/${r.intervals.length}`);
  // Shared CI runners get the bench's ×2 slack.
  const slack = process.env.CI ? 2 : 1;
  expect(p95(r.work)).toBeLessThan(8 * slack);
  expect(p95(r.intervals)).toBeLessThan((1000 / 50) * slack);
  expect(p95(latency)).toBeLessThan(8 * slack);
});

test('falls back to drawing on the main thread when blob workers are not allowed', async ({ page }) => {
  h = await openGraph(page, 'wide-100k', { csp: (c) => c.replace('; worker-src blob:', '') });
  await expect(page.locator('[role=option] .subject').first()).toHaveText(/\S/);
  await expect(page.locator('.graph')).toHaveAttribute('data-renderer', 'main');
  await expect.poll(() => pixelAt(page, 12, 11)).toEqual([0x37, 0x94, 0xff]);
});

test('re-reads theme colours when VS Code switches theme', async ({ page }) => {
  h = await openGraph(page, 'wide-100k');
  await expect(page.locator('[role=option] .subject').first()).toHaveText(/\S/);
  // The first commit's node: lane 0, row 0 → centre at CSS (12, 11).
  const nodePixel = () => pixelAt(page, 12, 11);
  await expect.poll(nodePixel).toEqual([0x37, 0x94, 0xff]); // Dark Modern charts.blue

  await page.evaluate(() => {
    document.documentElement.style.setProperty('--vscode-charts-blue', '#005fb8');
    document.body.classList.replace('vscode-dark', 'vscode-light');
  });
  await expect.poll(nodePixel).toEqual([0x00, 0x5f, 0xb8]);
});
