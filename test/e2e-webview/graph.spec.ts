import { expect, test } from '@playwright/test';
import { openGraph, pixelAt, timeFromDelivery, type Harness } from './harness';

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

test('editor → graph sync scrolls to the commit, pulses it and outlines the line lineage', async ({ page }) => {
  h = await openGraph(page, 'wide-100k');
  await expect(page.locator('[role=option] .subject').first()).toHaveText(/\S/);
  const row = 42_000;

  // Stage 1: the host pushes the cursor line's commit. Measured in the page: message in → the row is on
  // screen, highlighted and filled in (its page fetched from the worker).
  const elapsed = await timeFromDelivery(
    page,
    `document.querySelector('#row-${row}.synced .subject')?.textContent.length > 0`,
  );
  h.host.emit('graph.sync', { sha: 'x'.repeat(40), row, seq: 1 });
  const stage1 = await elapsed();
  console.log(`sync message → row visible, highlighted and filled: ${stage1.toFixed(1)} ms`);
  expect(stage1).toBeLessThan(100 * (process.env.CI ? 2 : 1));
  // Centred in the viewport.
  const box = (await page.locator(`#row-${row}`).boundingBox())!;
  expect(Math.abs(box.y + 11 - 300)).toBeLessThanOrEqual(22);

  // Stage 2: lineage for a stale sync is ignored; the current one is outlined (a ring around the node).
  h.host.emit('graph.lineage', { seq: 0, rows: [row + 1] });
  h.host.emit('graph.lineage', { seq: 1, rows: [row, row + 3] });
  await page.waitForTimeout(400); // let the pulse finish
  await page.screenshot({ path: 'test-results/graph-sync.png' });

  // A sync to the same commit again (new seq) does not scroll away if it is already visible.
  const before = await page.locator('.scroller').evaluate((el) => el.scrollTop);
  h.host.emit('graph.sync', { sha: 'x'.repeat(40), row: row + 2, seq: 2 });
  await expect(page.locator(`#row-${row + 2}`)).toHaveClass(/synced/);
  expect(await page.locator('.scroller').evaluate((el) => el.scrollTop)).toBe(before);

  // Cursor on an uncommitted line: no synced row.
  h.host.emit('graph.sync', null);
  await expect(page.locator('.row.synced')).toHaveCount(0);
});

test('labels refs and HEAD; clicking a commit opens its details', async ({ page }) => {
  h = await openGraph(page, 'small');
  const rows = page.locator('[role=option]');
  await expect(rows.nth(0).locator('.subject')).toHaveText("Merge branch 'feature'");
  // HEAD's branch chip is marked; another branch is a plain chip; codicons load under the CSP.
  await expect(rows.nth(0).locator('.ref.head')).toHaveText('main');
  await expect(page.locator('.ref.branch', { hasText: 'feature' })).toBeVisible();
  expect(await page.evaluate(() => document.fonts.check('12px codicon'))).toBe(true);

  h.openFiles.push('src/feature.ts');
  await rows.nth(0).click();
  const details = page.locator('aside.details');
  await expect(details.locator('h2')).toHaveText("Merge branch 'feature'");
  await expect(details.locator('dt', { hasText: 'Parents' })).toBeVisible();
  // A merge is diffed against its first parent: only the feature branch's file.
  await expect(details.locator('h3')).toContainText('1 file changed');
  await expect(details.locator('h4', { hasText: 'Open in editor' })).toBeVisible();
  await expect(details.locator('[role=tree]').first().locator('.name')).toHaveText(['src/feature.ts']);
  await expect(details.locator('.open-badge')).toHaveCount(2); // pinned copy and tree entry

  await details.locator('button[title="Copy SHA"]').click();
  await expect.poll(() => h!.clipboard.length).toBe(1);
  expect(h.clipboard[0]).toMatch(/^[0-9a-f]{40}$/);

  // Jump to the second parent (the feature commit): it becomes the selected row.
  await details.locator('dd button.link').nth(1).click();
  await expect(details.locator('h2')).toHaveText('feature work');
  await expect(page.locator('[role=option][aria-selected=true] .subject')).toHaveText('feature work');
  await page.screenshot({ path: 'test-results/graph-details.png' });

  // A tab closed in the editor: the pin goes away without reopening the pane.
  h.host.emit('graph.openFiles', { root: h.root, paths: [] });
  await expect(details.locator('.open-badge')).toHaveCount(0);

  await details.locator('button[title="Close details"]').click();
  await expect(details).toHaveCount(0);
});
