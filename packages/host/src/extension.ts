/**
 * Extension host entry. The host only orchestrates: git work runs in the engine's worker pool,
 * which starts on the first git call. activate() does no I/O so it stays under the 30 ms budget;
 * repository discovery runs after it returns.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { WorkerPool } from '@gvx/git-engine';
import type { IndexStats } from '@gvx/protocol';
import type { GitAPI, GitExtension } from './gitApi';
import { RepoSession } from './repoSession';
import { SelectionStore } from './selectionStore';

export function activate(context: vscode.ExtensionContext) {
  const started = performance.now();
  const log = vscode.window.createOutputChannel('GitVision', { log: true });
  const selection = new SelectionStore();
  const sessions = new Map<string, RepoSession>();
  const storageDir = context.globalStorageUri.fsPath;
  const refsEvents: { root: string; tips: number; mode: string }[] = [];

  let gitApi: GitAPI | undefined;
  const pool = new WorkerPool({
    workerPath: path.join(context.extensionPath, 'dist', 'worker.js'),
    get gitPath() {
      return gitApi?.git.path ?? 'git';
    },
    log: (m) => log.info(m),
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dev-only, dropped from production bundles
    validate: __DEV__ ? require('../../protocol/src/schemas').validateWire : undefined,
  });
  context.subscriptions.push(log, { dispose: () => pool.dispose() }, { dispose: () => sessions.forEach((s) => s.dispose()) });

  const openRepo = async (dir: string) => {
    const info = await pool.request('repo.resolve', { path: dir });
    if (!info || sessions.has(info.root)) return;
    const session = new RepoSession(info, pool, storageDir, log);
    sessions.set(info.root, session);
    session.onDidSync((s: IndexStats) => {
      if (s.refsChanged) refsEvents.push({ root: s.root, tips: s.tips.length, mode: s.mode });
    });
    updateSelection();
    await session.sync();
  };
  const closeRepo = (root: string) => {
    sessions.get(root)?.dispose();
    sessions.delete(root);
    updateSelection();
  };

  const repoFor = (fsPath: string): RepoSession | undefined => {
    const p = realDir(fsPath);
    let best: RepoSession | undefined;
    for (const s of sessions.values()) {
      const root = s.root.endsWith('/') ? s.root : `${s.root}/`;
      if (sameFsPrefix(p, root) && (!best || s.root.length > best.root.length)) best = s;
    }
    return best;
  };
  const updateSelection = () => {
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri;
    const repo = uri?.scheme === 'file' ? repoFor(uri.fsPath) : undefined;
    selection.update({
      repo: repo?.root ?? null,
      file: repo && uri ? path.relative(repo.root, realDir(uri.fsPath)).replace(/\\/g, '/') : null,
      line: editor ? editor.selection.active.line : null,
    });
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateSelection),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor) selection.update({ line: e.selections[0]?.active.line ?? null });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gitvision.rebuildIndex', () =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'GitVision: rebuilding commit index' },
        () => Promise.all([...sessions.values()].map((s) => s.sync(true))),
      ),
    ),
    vscode.commands.registerCommand('gitvision.showIndexStats', () => {
      const lines = [...sessions.values()].map((s) =>
        s.lastStats ? `${path.basename(s.root)}: ${s.lastStats.commitCount} commits (${s.lastStats.mode}, ${s.lastStats.durationMs} ms)` : `${path.basename(s.root)}: not indexed yet`,
      );
      void vscode.window.showInformationMessage(lines.length ? lines.join(' · ') : 'GitVision: no git repositories open.');
    }),
  );

  // Discovery runs after activation returns.
  setTimeout(() => {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
    try {
      gitApi = ext?.enabled ? ext.getAPI(1) : undefined;
    } catch (e) {
      log.warn(`vscode.git API unavailable: ${(e as Error).message}`);
    }
    const tryOpen = (dir: string) => openRepo(dir).catch((e) => log.error(`Could not open ${dir}: ${(e as Error).message}`));
    if (gitApi) {
      context.subscriptions.push(
        gitApi.onDidOpenRepository((r) => void tryOpen(r.rootUri.fsPath)),
        gitApi.onDidCloseRepository((r) => {
          for (const s of sessions.values()) if (sameFsPath(s.root, r.rootUri.fsPath)) closeRepo(s.root);
        }),
      );
      for (const r of gitApi.repositories) void tryOpen(r.rootUri.fsPath);
    }
    // vscode.git may be disabled or still scanning; workspace folders are a fallback.
    for (const f of vscode.workspace.workspaceFolders ?? []) if (f.uri.scheme === 'file') void tryOpen(f.uri.fsPath);
  }, 0);

  const activationMs = performance.now() - started;

  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
      vscode.commands.registerCommand('gitvision._test.state', () => ({
        activationMs,
        workersStarted: pool.started,
        repos: [...sessions.values()].map((s) => ({ info: s.info, stats: s.lastStats })),
        selection: selection.get(),
        refsEvents,
      })),
      vscode.commands.registerCommand('gitvision._test.blame', (root: string, file: string) =>
        pool.request('blame.file', { root, path: file }, { affinity: root }).then((b) => ({
          lines: b.lineCommit.length,
          commits: b.commits.length,
          cacheHit: b.cacheHit,
        })),
      ),
    );
  }
  log.info(`activated in ${activationMs.toFixed(1)} ms`);
}

export function deactivate() {}

/**
 * git reports resolved paths (/private/var/… on macOS, no symlinked folders); editors may hold the
 * symlinked path. Resolve the file's directory once and cache it.
 */
const realDirs = new Map<string, string>();
function realDir(fsPath: string): string {
  const dir = path.dirname(fsPath);
  let real = realDirs.get(dir);
  if (real === undefined) {
    try {
      real = fs.realpathSync.native(dir);
    } catch {
      real = dir;
    }
    if (realDirs.size > 2000) realDirs.clear();
    realDirs.set(dir, real);
  }
  return path.join(real, path.basename(fsPath)).replace(/\\/g, '/');
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
function sameFsPrefix(p: string, prefix: string): boolean {
  return norm(p).startsWith(norm(prefix));
}
function sameFsPath(a: string, b: string): boolean {
  return norm(a.replace(/\\/g, '/').replace(/\/$/, '')) === norm(b.replace(/\\/g, '/').replace(/\/$/, ''));
}
