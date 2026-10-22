import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const syncProcess = {
  name: 'child_process',
  importNames: ['execSync', 'execFileSync', 'spawnSync', 'exec'],
  message: 'Spawn git asynchronously with spawn(); exec and sync calls block the event loop.',
};

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', '.vscode-test/**', 'node_modules/**', 'test/fixtures/repos/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly', Buffer: 'readonly', performance: 'readonly' } },
  },
  {
    files: ['packages/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [syncProcess, { ...syncProcess, name: 'node:child_process' }] }],
    },
  },
  {
    // The host orchestrates only: no git processes, no parsing (spec: Layer responsibilities).
    files: ['packages/host/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: ['child_process', 'node:child_process'].map((name) => ({ name, message: 'The host never spawns git; send a request to the git engine.' })),
      }],
    },
  },
  {
    // Workers must not touch the vscode API.
    files: ['packages/git-engine/**/*.ts', 'packages/protocol/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: 'git-engine and protocol run outside the extension host.' }, syncProcess, { ...syncProcess, name: 'node:child_process' }],
      }],
    },
  },
);
