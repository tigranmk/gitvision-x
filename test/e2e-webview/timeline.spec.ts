import { expect, test } from '@playwright/test';
import { openTimeline, type TimelineHarness } from './harness';

let h: TimelineHarness | undefined;
test.afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

test('offers to start for the active file, then shows one tick per revision with the working copy at the right', async ({ page }) => {
  h = await openTimeline(page, 'renames', 'lib/helpers.ts', { active: false });
  await expect(page.locator('.idle')).toContainText('helpers.ts');
  await page.getByRole('button', { name: /Start time travel/ }).click();
  await expect.poll(() => h!.calls).toEqual(['start']);
  const slider = page.getByRole('slider');
  await expect(slider).toHaveAttribute('aria-valuetext', /move helpers to lib|split helpers/);
  await expect(page.locator('.tick:not(.now)')).toHaveCount(h.revisions.length);
  await expect(page.locator('.label.now-label')).toHaveText('Now');
  expect(h.cspViolations).toEqual([]);
});

test('drag, click and keys step through revisions; renamed revisions say where the file was', async ({ page }) => {
  h = await openTimeline(page, 'renames', 'lib/helpers.ts');
  const slider = page.getByRole('slider');
  await expect(page.locator('.tick:not(.now)')).toHaveCount(h.revisions.length);
  const n = h.revisions.length;

  // Keyboard: ← goes back from the working copy to the newest revision, then older.
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => h!.gos).toEqual([0, 1]);
  await page.keyboard.press('Home');
  await expect.poll(() => h!.gos.at(-1)).toBe(n - 1);
  // The oldest revision predates two renames.
  await expect(page.locator('.details')).toContainText(`was ${h.revisions[n - 1]!.path}`);
  await page.keyboard.press('End');
  await expect.poll(() => h!.gos.at(-1)).toBe(-1);

  // Drag from the right end to the left end: every revision on the way, in order, without repeats.
  const box = (await slider.boundingBox())!;
  h.gos.length = 0;
  await page.mouse.move(box.x + box.width - 2, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + 2, box.y + 15, { steps: 30 });
  await page.mouse.up();
  await expect.poll(() => h!.gos.at(-1)).toBe(n - 1);
  expect(h.gos).toEqual([...new Set(h.gos)]);

  // A tick's tooltip names the commit; the pin and list buttons reach the host.
  await expect(page.locator('.tick').first()).toHaveAttribute('title', new RegExp(h.revisions[n - 1]!.subject));
  await page.getByRole('button', { name: 'Pin revision to compare' }).click();
  await page.getByRole('button', { name: 'All revisions' }).click();
  await page.getByRole('button', { name: 'Return to working copy' }).click();
  await expect.poll(() => h!.calls).toEqual(['pin', 'pick', 'exit']);

  // While a partial clone fetches the blob, the thumb shows a spinner.
  h.push({ index: 2, loading: 2 });
  await expect(page.locator('.thumb .codicon-loading')).toBeVisible();
  h.push({ loading: null });
  await expect(page.locator('.thumb .codicon-loading')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/timeline.png' });
});

test('buckets 500+ revisions by week', async ({ page }) => {
  h = await openTimeline(page, 'revisions-500', 'notes.md');
  // 500 revisions, one a day: exactly at the limit, one tick each.
  await expect(page.locator('.tick:not(.now)')).toHaveCount(500);
  await expect(page.locator('.details')).not.toContainText('one tick per week');
});
