// Runs the integration suite in a real VS Code (downloaded to .vscode-test/).
//   VSCODE_VERSION=1.95.0 node test/integration/run.mjs   pin a version (default: stable)
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const r = spawnSync(process.execPath, ['scripts/fixtures.mjs', '--only', 'small'], { cwd: ROOT, stdio: 'inherit' });
if (r.status !== 0) process.exit(1);

await esbuild.build({
  entryPoints: [path.join(ROOT, 'test/integration/index.ts')],
  outfile: path.join(ROOT, 'out/integration/index.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'mocha'],
  logLevel: 'warning',
});

// The suite commits into its workspace, so it gets a throwaway copy. Not realpath'd on purpose:
// on macOS this keeps the /var → /private/var symlink in play.
const scratch = mkdtempSync(path.join(tmpdir(), 'gvx-it-'));
const workspace = path.join(scratch, 'small');
cpSync(path.join(ROOT, 'test/fixtures/repos/small'), workspace, { recursive: true });

// Set when this script itself runs inside VS Code's terminal; it would make Electron start as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

// test-electron's own retries are back to back, so one CDN blip fails all of them; space ours out.
async function downloadVSCode(version) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadAndUnzipVSCode(version);
    } catch (e) {
      if (attempt === 4) throw e;
      console.error(`VS Code download failed (attempt ${attempt} of 4), retrying in ${attempt * 10} s`);
      await sleep(attempt * 10_000);
    }
  }
}

try {
  await runTests({
    vscodeExecutablePath: await downloadVSCode(process.env.VSCODE_VERSION ?? 'stable'),
    extensionDevelopmentPath: ROOT,
    extensionTestsPath: path.join(ROOT, 'out/integration/index.cjs'),
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--user-data-dir', path.join(scratch, 'user-data')],
    extensionTestsEnv: { GVX_WORKSPACE: workspace, GVX_WORKSPACE_REAL: realpathSync.native(workspace) },
  });
} catch (e) {
  console.error('Integration tests failed:', e);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
// Exit explicitly: an aborted download leaves a socket open, and waiting on it hung CI for 6 hours.
process.exit(process.exitCode ?? 0);
