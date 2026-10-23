// Runs the integration suite in a Remote-SSH window: the UI here, the extension host on a Linux host.
//   node test/integration/run-remote.mjs --ssh <host> [--ssh-config <file>] [--remote-dir <path>]
// The host needs key auth, git, and write access to --remote-dir (default /tmp/gvx-remote); point that at a
// folder bind-mounted from here to cover a Dev Containers-style workspace. Dev Containers itself can't be
// driven this way: it asks for a one-time confirmation before attaching, and test instances refuse dialogs.
// Remote-SSH is installed into a throwaway extensions folder, never your own VS Code's.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const host = arg('--ssh');
const sshConfig = arg('--ssh-config');
const REMOTE = arg('--remote-dir') ?? '/tmp/gvx-remote';
if (!host) {
  console.error('usage: run-remote.mjs --ssh <host> [--ssh-config <file>] [--remote-dir <path>]');
  process.exit(2);
}

const step = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
step(process.execPath, ['scripts/build.mjs', '--production']);
step(process.execPath, ['scripts/fixtures.mjs', '--only', 'small']);
// mocha is bundled: the remote has no node_modules.
await esbuild.build({
  entryPoints: [path.join(ROOT, 'test/integration/index.ts')],
  outfile: path.join(ROOT, 'out/integration/remote.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'warning',
});

// Stage the extension and a fresh copy of the fixture. The remote server's data folder outlives a run,
// so the extension's index and blame cache from earlier runs are removed too.
const remoteSh = (script, input) =>
  execFileSync('ssh', [...(sshConfig ? ['-F', sshConfig] : []), host, script], { input, stdio: ['pipe', 'pipe', 'inherit'], maxBuffer: 1 << 28 });
// COPYFILE_DISABLE: macOS tar would otherwise add ._* metadata files.
const tar = (dir, ...entries) =>
  execFileSync('tar', ['-C', dir, '-cf', '-', ...entries], { maxBuffer: 1 << 28, env: { ...process.env, COPYFILE_DISABLE: '1' } });
remoteSh(`rm -rf ${REMOTE} ~/.vscode-server/data/User/globalStorage/tigranmk.gitvision-x && mkdir -p ${REMOTE}/ext/out/integration ${REMOTE}/small`);
remoteSh(`tar -C ${REMOTE}/ext -xf -`, tar(ROOT, 'package.json', 'dist'));
remoteSh(`tar -C ${REMOTE}/ext/out/integration -xf -`, tar(path.join(ROOT, 'out/integration'), 'remote.cjs'));
remoteSh(`tar -C ${REMOTE}/small -xf -`, tar(path.join(ROOT, 'test/fixtures/repos/small'), '.'));
const remoteOs = remoteSh('uname -sm').toString().trim();
const remoteUri = (p) => `vscode-remote://ssh-remote+${host}${p}`;

const scratch = mkdtempSync(path.join(tmpdir(), 'gvx-remote-'));
const extensionsDir = path.join(scratch, 'extensions');
const userData = path.join(scratch, 'user-data');
mkdirSync(path.join(userData, 'User'), { recursive: true });
writeFileSync(
  path.join(userData, 'User/settings.json'),
  JSON.stringify({
    ...(sshConfig ? { 'remote.SSH.configFile': path.resolve(sshConfig) } : {}),
    'remote.SSH.remotePlatform': { [host]: 'linux' },
    'remote.SSH.showLoginTerminal': false,
    'security.workspace.trust.enabled': false,
    'extensions.autoUpdate': false,
  }),
);

delete process.env.ELECTRON_RUN_AS_NODE;
try {
  const vscodeExecutablePath = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION ?? 'stable');
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  execFileSync(cli, [...cliArgs, '--extensions-dir', extensionsDir, '--install-extension', 'ms-vscode-remote.remote-ssh'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  console.log(`remote: ${host} (${remoteOs}), workspace ${REMOTE}/small`);
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: remoteUri(`${REMOTE}/ext`),
    extensionTestsPath: remoteUri(`${REMOTE}/ext/out/integration/remote.cjs`),
    launchArgs: ['--folder-uri', remoteUri(`${REMOTE}/small`), '--extensions-dir', extensionsDir, '--user-data-dir', userData],
  });
} catch (e) {
  console.error('Remote integration tests failed:', e);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
