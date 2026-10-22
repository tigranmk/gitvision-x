import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __DEV__: 'true' },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'test/unit/**/*.test.ts'],
    testTimeout: 30_000,
    globalSetup: ['test/unit/globalSetup.ts'],
  },
});
