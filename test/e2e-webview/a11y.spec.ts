import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { DARK_THEME, openGraph, openTimeline, type Harness, type TimelineHarness } from './harness';

const HC_THEME = {
  ...DARK_THEME,
  '--vscode-sideBar-background': '#000000',
  '--vscode-editor-background': '#000000',
  '--vscode-foreground': '#ffffff',
  '--vscode-contrastBorder': '#6fc3df',
  '--vscode-contrastActiveBorder': '#f38518',
  '--vscode-list-focusOutline': '#f38518',
  '--vscode-list-activeSelectionBackground': 'transparent',
};

let g: Harness | undefined;
let t: TimelineHarness | undefined;
test.afterEach(async () => {
  await g?.dispose();
  await t?.dispose();
  g = t = undefined;
});

test('high contrast: chips outlined in the contrast colour, square corners, the selected row outlined', async ({ page }) => {
  g = await openGraph(page, 'small', { theme: HC_THEME, bodyClass: 'vscode-high-contrast' });
  const chip = page.locator('.ref', { hasText: 'feature' });
  await expect(chip).toBeVisible();
  expect(await chip.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe('rgb(111, 195, 223)');
  expect(await chip.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('0px');
  const row = page.locator('[role=option]').nth(2);
  await row.click();
  await expect.poll(() => row.evaluate((el) => `${getComputedStyle(el).outlineStyle} ${getComputedStyle(el).outlineColor}`)).toBe('solid rgb(243, 133, 24)');
  await page.screenshot({ path: 'test-results/a11y-high-contrast.png' });
});

test('reduced motion: no transitions, no pulse animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  t = await openTimeline(page, 'renames', 'lib/helpers.ts');
  await expect(page.locator('.thumb')).toBeVisible();
  expect(await page.locator('.thumb').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
});

test('keyboard reaches every timeline control, and the slider moves with the arrows', async ({ page }) => {
  t = await openTimeline(page, 'renames', 'lib/helpers.ts');
  await expect(page.getByRole('slider')).toBeVisible();
  const names: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    names.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? ''));
  }
  // Pin is unavailable on the working copy but stays reachable (aria-disabled) so it can say why.
  expect(names).toEqual(['Previous revision', 'Next revision', 'Pin revision to compare', 'All revisions', 'Return to working copy', expect.stringMatching(/^Revision of/)]);
  await expect(page.getByRole('button', { name: 'Pin revision to compare' })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => t!.gos).toEqual([0]);
});

test('keyboard reaches the conflict map’s files, cards and operation buttons', async ({ page }) => {
  const sha = (root: string, rev: string) => execFileSync('git', ['rev-parse', rev], { cwd: root, encoding: 'utf8' }).trim();
  g = await openGraph(page, 'small', {
    conflict: (root) => ({
      op: 'rebase',
      ours: sha(root, 'main'),
      theirs: sha(root, 'feature'),
      oursLabel: 'main',
      theirsLabel: 'feature',
      rebase: { step: 2, total: 5 },
      hunksTotal: 1,
      hunksResolved: 0,
      files: [{ path: 'logo.png', kind: 'binary', total: null, remaining: null, resolved: false }],
    }),
  });
  await page.locator('[role=option]').first().click();
  const map = page.locator('aside.conflict-map');
  await expect(map.locator('p')).toHaveText('Step 2 of 5 · 1 conflict left');
  // From the close button, Tab walks the file, its card and the operation buttons; Enter activates.
  await map.getByRole('button', { name: 'Close' }).focus();
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    seen.push(await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute('aria-label') ?? (document.activeElement as HTMLElement).innerText.trim()));
  }
  // Continue cannot run yet (a binary file is unresolved) but stays reachable and says why.
  expect(seen).toEqual(['Open logo.png', 'Keep main', 'Keep feature', 'Continue', 'Skip commit', 'Abort rebase']);
  await expect(map.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect.poll(() => g!.conflictCalls).toEqual(['run:skip']);
});

test('hovering a lane names its branch', async ({ page }) => {
  g = await openGraph(page, 'small');
  const merge = page.locator('[role=option]').first();
  await expect(merge.locator('.subject')).toHaveText("Merge branch 'feature'");
  await expect(page.locator('.ref', { hasText: 'feature' })).toBeVisible(); // refs arrive after the first rows
  // Lane 1 (x = 4 + 16 + 8) at the "feature work" row: the feature branch's tip opens it.
  const row = page.locator('[role=option]', { hasText: 'feature work' });
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 28, box.y + 11);
  await expect(page.getByRole('tooltip')).toHaveText('Branch feature');
  await page.mouse.move(box.x + 12, box.y + 11);
  await expect(page.getByRole('tooltip')).toHaveText('Branch main');
});
