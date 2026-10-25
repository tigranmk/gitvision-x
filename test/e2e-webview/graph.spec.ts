import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { openGraph, pixelAt, timeFromDelivery, type Harness } from './harness';

/** The toolbar above the rows: 28 px + a 1 px border. */
const TOP = 29;

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
  // Rows are absolutely placed inside the sticky viewport: the target row sits at the top, under the toolbar.
  const box = await page.locator(`#row-${target}`).boundingBox();
  expect(Math.round(box!.y)).toBe(TOP);
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
  await expect.poll(() => pixelAt(page, 12, TOP + 11)).toEqual([0x37, 0x94, 0xff]);
});

test('re-reads theme colours when VS Code switches theme', async ({ page }) => {
  h = await openGraph(page, 'wide-100k');
  await expect(page.locator('[role=option] .subject').first()).toHaveText(/\S/);
  // The first commit's node: lane 0, row 0 → centre at CSS (12, TOP + 11).
  const nodePixel = () => pixelAt(page, 12, TOP + 11);
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
  const shaAt = async (r: number) => (await h!.pool.request('graph.page', { root: h!.root, start: r, count: 1 }, { affinity: h!.root })).commits[0]!.sha;
  const sha = await shaAt(row);

  // Stage 1: the host pushes the cursor line's commit. Measured in the page: message in → the row is on
  // screen, highlighted and filled in (its row looked up and its page fetched from the worker).
  const elapsed = await timeFromDelivery(
    page,
    `document.querySelector('#row-${row}.synced .subject')?.textContent.length > 0`,
  );
  h.host.emit('graph.sync', { sha, seq: 1 });
  const stage1 = await elapsed();
  console.log(`sync message → row visible, highlighted and filled: ${stage1.toFixed(1)} ms`);
  expect(stage1).toBeLessThan(100 * (process.env.CI ? 2 : 1));
  // Centred in the list (below the toolbar).
  const box = (await page.locator(`#row-${row}`).boundingBox())!;
  expect(Math.abs(box.y + 11 - (TOP + (600 - TOP) / 2))).toBeLessThanOrEqual(22);

  // Stage 2: lineage for a stale sync is ignored; the current one is outlined (a ring around the node).
  h.host.emit('graph.lineage', { seq: 0, shas: [await shaAt(row + 1)] });
  h.host.emit('graph.lineage', { seq: 1, shas: [sha, await shaAt(row + 3)] });
  await page.waitForTimeout(400); // let the pulse finish
  await page.screenshot({ path: 'test-results/graph-sync.png' });

  // Another commit already on screen: highlighted without scrolling.
  const before = await page.locator('.scroller').evaluate((el) => el.scrollTop);
  h.host.emit('graph.sync', { sha: await shaAt(row + 2), seq: 2 });
  await expect(page.locator(`#row-${row + 2}`)).toHaveClass(/synced/);
  expect(await page.locator('.scroller').evaluate((el) => el.scrollTop)).toBe(before);

  // Cursor on an uncommitted line: no synced row.
  h.host.emit('graph.sync', null);
  await expect(page.locator('.row.synced')).toHaveCount(0);
});

test('filters to the current branch or the active file, and keeps the choice', async ({ page }) => {
  h = await openGraph(page, 'small');
  const subjects = page.locator('[role=option] .subject');
  await expect(subjects).toHaveCount(5);
  const filter = page.getByLabel('Commits shown');

  // Current branch (main) has every commit: the feature branch is merged. Check out feature instead.
  await filter.selectOption('branch');
  await expect(subjects).toHaveCount(5);
  execFileSync('git', ['checkout', '-q', 'feature'], { cwd: h.root });
  h.host.emit('graph.refresh', { root: h.root });
  await expect(subjects).toHaveText(['feature work', 'tweak app', 'initial']);
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: h.root });

  // Active file: only commits touching it, following the editor.
  await filter.selectOption('file');
  await expect(page.locator('.message')).toContainText('Open a file');
  h.host.emit('graph.activeFile', { root: h.root, path: 'src/app.ts' });
  await expect(subjects).toHaveText(['tweak app', 'initial']);
  await expect(page.locator('.scope')).toHaveText('src/app.ts');
  h.host.emit('graph.activeFile', { root: h.root, path: 'README.md' });
  await expect(subjects).toHaveText(['main work', 'initial']);

  // The choice survives a reload of the webview (vscode.setState).
  expect(await page.evaluate(() => (window as unknown as { acquireVsCodeApi(): { getState(): unknown } }).acquireVsCodeApi().getState())).toEqual({ filter: 'file' });
});

test('/ searches message, author, SHA and path; Enter steps through matches; Escape closes', async ({ page }) => {
  h = await openGraph(page, 'wide-100k');
  await expect(page.locator('[role=option] .subject').first()).toHaveText(/\S/);
  await page.locator('[role=listbox]').focus();
  await page.keyboard.press('/');
  const input = page.getByLabel(/Search commits by message/);
  await expect(input).toBeFocused();

  await input.fill('Merge feature-7');
  await expect(page.locator('.search .count')).toHaveText(/^1 of \d+$/);
  const firstSelected = await page.locator('[role=option][aria-selected=true] .subject').textContent();
  expect(firstSelected).toBe('Merge feature-7');
  await input.press('Enter');
  await expect(page.locator('.search .count')).toHaveText(/^2 of /);
  await expect(page.locator('[role=option][aria-selected=true] .subject')).toHaveText('Merge feature-7');
  await input.press('Shift+Enter');
  await expect(page.locator('.search .count')).toHaveText(/^1 of /);

  // SHA prefix: exactly one commit.
  const sha = (await h.pool.request('graph.page', { root: h.root, start: 777, count: 1 }, { affinity: h.root })).commits[0]!.sha;
  await input.fill(sha.slice(0, 8));
  await expect(page.locator('.search .count')).toHaveText('1 of 1');
  await expect(page.locator('#row-777')).toHaveAttribute('aria-selected', 'true');

  // Author and path (counting starts at the first match at or below the viewport, here row 777).
  await input.fill('dev7@example.com');
  await expect(page.locator('.search .count')).toHaveText(/^\d+ of \d{3,}$/);
  await input.fill('path:src/f499.ts');
  await expect(page.locator('.search .count')).toHaveText(/^\d+ of \d+$/);
  await input.fill('no such thing anywhere');
  await expect(page.locator('.search .count')).toHaveText('No results');

  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(page.locator('[role=listbox]')).toBeFocused();
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

test('micro-diff previews the selected or hovered file; double-click or Enter opens the diff editor', async ({ page }) => {
  h = await openGraph(page, 'small');
  await page.locator('[role=option]', { hasText: 'tweak app' }).click();
  const details = page.locator('aside.details');
  await expect(details.locator('h2')).toHaveText('tweak app');
  const file = details.locator('.row-button', { hasText: 'app.ts' });
  await file.click();
  const diff = page.locator('.micro-diff');
  await expect(diff.locator('h4')).toHaveText('src/app.ts');
  // app.ts grew from 10 to 12 lines: two added rows after 3 lines of context.
  await expect(diff.locator('tr.add')).toHaveCount(2);
  await expect(diff.locator('tr.add .right').first()).toHaveText('export const a10 = 10;');
  await expect(diff.locator('tr.same')).toHaveCount(3);
  await page.screenshot({ path: 'test-results/graph-micro-diff.png' });

  await file.dblclick();
  await file.press('Enter');
  await expect.poll(() => h!.diffsOpened.length).toBe(2);
  expect(h.diffsOpened[0]).toMatchObject({ file: { path: 'src/app.ts', status: 'M' } });
  expect(h.diffsOpened[0]!.parent).toMatch(/^[0-9a-f]{40}$/);

  // Hovering another commit's file previews it; leaving goes back to the selected file.
  await page.locator('[role=option]', { hasText: 'initial' }).click();
  await expect(details.locator('h2')).toHaveText('initial');
  await details.locator('.row-button', { hasText: 'README.md' }).hover();
  await expect(diff.locator('h4')).toHaveText('README.md');
  await expect(diff.locator('tr.add')).toHaveCount(1);
});

test('rows carry the context-menu data; dragging a branch onto another asks the host to merge or rebase', async ({ page }) => {
  h = await openGraph(page, 'small');
  const merge = page.locator('[role=option]').first();
  await expect(merge.locator('.subject')).toHaveText("Merge branch 'feature'");
  const ctx = JSON.parse((await merge.getAttribute('data-vscode-context'))!);
  expect(ctx).toMatchObject({ webviewSection: 'commit', root: h.root, subject: "Merge branch 'feature'", parents: 2, preventDefaultContextMenuItems: true });
  expect(ctx.sha).toMatch(/^[0-9a-f]{40}$/);
  // Right-click selects the row the menu is for.
  await page.locator('[role=option]', { hasText: 'main work' }).click({ button: 'right' });
  await expect(page.locator('[role=option][aria-selected=true] .subject')).toHaveText('main work');

  await page.locator('.ref', { hasText: 'feature' }).dragTo(page.locator('.ref', { hasText: 'main' }));
  await expect.poll(() => h!.drops.length).toBe(1);
  expect(h.drops[0]).toEqual({ root: h.root, source: { name: 'feature', kind: 'branch' }, target: { name: 'main', kind: 'branch' } });
});

test('labels other worktrees’ HEADs', async ({ page }) => {
  h = await openGraph(page, 'worktrees');
  const rows = page.locator('[role=option]');
  await expect(rows.nth(0).locator('.ref.worktree')).toHaveText('worktrees-feature');
  await expect(rows.nth(1).locator('.ref.worktree')).toHaveText('worktrees-detached (detached)');
  await expect(rows.nth(1).locator('.ref.worktree')).toHaveAttribute('title', /worktrees-detached: HEAD detached here$/);
});

test('a shallow clone ends with a "history truncated" row that fetches more', async ({ page }) => {
  h = await openGraph(page, 'shallow');
  const boundary = page.locator('.row.boundary');
  await expect(boundary).toContainText('History truncated (shallow clone)');
  expect(await boundary.getAttribute('id')).toBe(`row-${h.state.total}`);
  await boundary.getByRole('button', { name: 'Fetch more' }).click();
  await expect.poll(() => h!.fetches).toEqual([h.root]);
  await page.screenshot({ path: 'test-results/graph-shallow.png' });
});

test('keyboard: ↑/↓, Page/Home/End move the active row; Space selects; Enter opens; Escape closes', async ({ page }) => {
  h = await openGraph(page, 'wide-100k');
  await expect(page.locator('[role=option] .subject').first()).toHaveText(/\S/);
  const list = page.locator('[role=listbox]');
  // Tab reaches the filter, the search button, then the list.
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Commits shown')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Search commits')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(list).toBeFocused();
  await expect(list).toHaveAttribute('aria-activedescendant', 'row-0');

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(list).toHaveAttribute('aria-activedescendant', 'row-2');
  await expect(page.locator('#row-2')).toHaveClass(/active/);
  await page.keyboard.press('Space');
  await expect(page.locator('#row-2')).toHaveAttribute('aria-selected', 'true');
  const sha = await page.locator('#row-2').getAttribute('data-sha');
  await expect(page.locator('aside.details h2')).toHaveText(/\S/);

  await page.keyboard.press('Enter');
  await expect.poll(() => h!.commitsOpened).toEqual([sha]);

  // End jumps 100k rows; the active row is scrolled in, so its element exists for aria-activedescendant.
  await page.keyboard.press('End');
  await expect(list).toHaveAttribute('aria-activedescendant', `row-${h.state.total - 1}`);
  await expect(page.locator(`#row-${h.state.total - 1} .subject`)).toHaveText(/\S/);
  await page.keyboard.press('PageUp');
  const afterPageUp = Number((await list.getAttribute('aria-activedescendant'))!.slice(4));
  expect(afterPageUp).toBeLessThan(h.state.total - 10);
  await expect(page.locator(`#row-${afterPageUp}`)).toBeVisible();
  await page.keyboard.press('Home');
  await expect(list).toHaveAttribute('aria-activedescendant', 'row-0');
  await expect(page.locator('#row-0')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('aside.details')).toHaveCount(0);
});
