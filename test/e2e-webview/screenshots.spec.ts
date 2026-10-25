/**
 * Marketplace and walkthrough screenshots, rendered from the real webviews over the fixtures.
 * Opt-in: GVX_SCREENSHOTS=1 pnpm test:webview -g screenshots   (writes media/screenshots/*.png)
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { openGraph, openTimeline } from './harness';

const OUT = path.resolve(__dirname, '../../media/screenshots');
test.skip(!process.env.GVX_SCREENSHOTS, 'set GVX_SCREENSHOTS=1 to render the Marketplace screenshots');
test.use({ viewport: { width: 1100, height: 560 }, deviceScaleFactor: 1 });

test('screenshots: graph with commit details', async ({ page }) => {
  const h = await openGraph(page, 'wide-100k');
  await expect(page.locator('[role=option] .subject').first()).toHaveText(/\S/);
  await page.locator('.scroller').evaluate((el) => (el.scrollTop = 61_000 * 22));
  await page.locator('#row-61005').click();
  await expect(page.locator('aside.details h2')).toHaveText(/\S/);
  await page.locator('aside.details .row-button').last().hover();
  await expect(page.locator('.micro-diff table')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'graph.png') });
  await h.dispose();
});

test('screenshots: conflict map', async ({ page }) => {
  const sha = (root: string, rev: string) => execFileSync('git', ['rev-parse', rev], { cwd: root, encoding: 'utf8' }).trim();
  const h = await openGraph(page, 'small', {
    conflict: (root) => ({
      op: 'rebase',
      ours: sha(root, 'main~1'),
      theirs: sha(root, 'feature'),
      oursLabel: 'main',
      theirsLabel: 'feature',
      rebase: { step: 2, total: 3 },
      hunksTotal: 5,
      hunksResolved: 3,
      files: [
        { path: 'src/app.ts', kind: 'content', total: 3, remaining: 1, resolved: false },
        { path: 'src/feature.ts', kind: 'content', total: 1, remaining: 0, resolved: true },
        { path: 'assets/logo.png', kind: 'binary', total: null, remaining: null, resolved: false },
      ],
    }),
  });
  await page.locator('[role=option]').first().click();
  await expect(page.locator('aside.conflict-map h2')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'conflicts.png') });
  await h.dispose();
});

test('screenshots: time-travel timeline', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 150 });
  const t = await openTimeline(page, 'revisions-500', 'notes.md');
  await expect(page.locator('.tick:not(.now)')).toHaveCount(500);
  t.push({ index: 120 });
  await expect(page.locator('.details .subject')).toHaveText(/Revision/);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'timeline.png') });
  await t.dispose();
});
