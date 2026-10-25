import { defineConfig } from '@playwright/test';

// Webview UI tests: the built bundles in dist/webviews (run `pnpm build` first), in Chromium.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { browserName: 'chromium', viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 },
});
