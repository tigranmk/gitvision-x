/**
 * Extension host entry. The host only orchestrates: git work runs in the engine's worker pool,
 * which starts on the first git call. activate() does no I/O so it stays under the 30 ms budget;
 * repository discovery and blame start after it returns.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { WorkerPool } from '@gvx/git-engine';
import { BlameController } from './blame/blameController';
import { isFailure } from './blame/blameStore';
import type { GitAPI, GitExtension, GitRepository } from './gitApi';
import { registerCommitGraphOffer } from './commitGraphOffer';
import { offerGitLensCoexistence } from './gitlens';
import { GraphActions } from './graph/actions';
import { GraphViews } from './graph/graphViews';
import { enableTestAnswers, queueAnswers, shownPrompts } from './ui';
import { RepoRegistry } from './repoRegistry';
import { SelectionStore } from './selectionStore';

export function activate(context: vscode.ExtensionContext) {
  const started = performance.now();
  const log = vscode.window.createOutputChannel('GitVision', { log: true });
  const selection = new SelectionStore();
  const refsEvents: { root: string; tips: number; mode: string }[] = [];

  let gitApi: GitAPI | undefined;
  const pool = new WorkerPool({
    workerPath: path.join(context.extensionPath, 'dist', 'worker.js'),
    get gitPath() {
      return gitApi?.git.path ?? 'git';
    },
    log: (m) => log.info(m),
    trace: (m) => log.trace(m),
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dev-only, dropped from production bundles
    validate: __DEV__ ? require('../../protocol/src/schemas').validateWire : undefined,
  });
  const repos = new RepoRegistry(pool, context.globalStorageUri.fsPath, log);
  context.subscriptions.push(log, { dispose: () => pool.dispose() }, repos);

  const updateSelection = () => {
    const editor = vscode.window.activeTextEditor;
    const file = editor && repos.fileOf(editor.document.uri);
    selection.update({ repo: file?.session.root ?? null, file: file?.path ?? null, line: editor ? editor.selection.active.line : null });
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateSelection),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor) selection.update({ line: e.selections[0]?.active.line ?? null });
    }),
    repos.onDidOpen(updateSelection),
    repos.onDidClose(updateSelection),
    repos.onDidSync(({ stats }) => {
      if (stats.refsChanged) refsEvents.push({ root: stats.root, tips: stats.tips.length, mode: stats.mode });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gitvision.rebuildIndex', () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'GitVision: rebuilding commit index' }, () =>
        Promise.all(repos.all().map((s) => s.sync(true))),
      ),
    ),
    vscode.commands.registerCommand('gitvision.showIndexStats', () => {
      const lines = repos.all().map((s) =>
        s.lastStats
          ? `${path.basename(s.root)}: ${s.lastStats.commitCount} commits (${s.lastStats.mode}, ${s.lastStats.durationMs} ms)`
          : `${path.basename(s.root)}: not indexed yet`,
      );
      void vscode.window.showInformationMessage(lines.length ? lines.join(' · ') : 'GitVision: no git repositories open.');
    }),
  );

  let blame: BlameController | undefined;
  let graph: GraphViews | undefined;
  let actions: GraphActions | undefined;

  // Discovery and blame run after activation returns.
  setTimeout(() => {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
    try {
      gitApi = ext?.enabled ? ext.getAPI(1) : undefined;
    } catch (e) {
      log.warn(`vscode.git API unavailable: ${(e as Error).message}`);
    }
    blame = new BlameController(context, pool, repos, selection, () => gitApi, log);
    actions = new GraphActions(pool, repos, () => gitApi);
    graph = new GraphViews(context.extensionUri, pool, repos, selection, () => blame, () => gitApi, actions);
    context.subscriptions.push(actions);
    context.subscriptions.push(blame.store.onDidLoad(() => graph?.blameLoaded()));
    context.subscriptions.push(blame, graph, registerCommitGraphOffer(context, pool, repos, log));
    const tryOpen = (dir: string) => repos.open(dir).catch((e) => log.error(`Could not open ${dir}: ${(e as Error).message}`));
    if (gitApi) {
      // vscode.git's own refresh is a second change signal next to our .git watchers: file events in
      // .git can arrive late or not at all (seen with FSEvents on CI), and a poke costs one cheap sync.
      const follow = (r: GitRepository) => {
        void tryOpen(r.rootUri.fsPath);
        context.subscriptions.push(r.state.onDidChange(() => repos.sessionAt(r.rootUri.fsPath)?.poke()));
      };
      context.subscriptions.push(
        gitApi.onDidOpenRepository(follow),
        gitApi.onDidCloseRepository((r) => repos.closeByPath(r.rootUri.fsPath)),
      );
      gitApi.repositories.forEach(follow);
    }
    // vscode.git may be disabled or still scanning; workspace folders are a fallback.
    for (const f of vscode.workspace.workspaceFolders ?? []) if (f.uri.scheme === 'file') void tryOpen(f.uri.fsPath);
    void offerGitLensCoexistence(context, log);
  }, 0);

  const activationMs = performance.now() - started;

  if (context.extensionMode === vscode.ExtensionMode.Test) {
    enableTestAnswers();
    context.subscriptions.push(
      vscode.commands.registerCommand('gitvision._test.answer', (...a: (string | undefined)[]) => queueAnswers(...a)),
      vscode.commands.registerCommand('gitvision._test.prompts', () => shownPrompts.splice(0)),
      vscode.commands.registerCommand('gitvision._test.dropBranch', (d: Parameters<GraphActions['dropBranch']>[0]) => actions?.dropBranch(d)),
      vscode.commands.registerCommand('gitvision._test.state', () => ({
        activationMs,
        workersStarted: pool.started,
        repos: repos.all().map((s) => ({ info: s.info, stats: s.lastStats })),
        selection: selection.get(),
        refsEvents,
        lastRender: blame?.lastRender,
        graph: graph?.state(),
        graphSync: graph?.lastSync,
        graphLineage: graph?.lastLineage,
        lastWrite: actions?.lastWrite,
      })),
      vscode.commands.registerCommand('gitvision._test.blame', (root: string, file: string) =>
        pool.request('blame.file', { root, path: file }, { affinity: root }).then((b) => ({
          lines: b.lineCommit.length,
          commits: b.commits.length,
          cacheHit: b.cacheHit,
        })),
      ),
      vscode.commands.registerCommand('gitvision._test.graphOpenDiff', (a: Parameters<GraphViews['openDiff']>[0]) => graph?.openDiff(a)),
      vscode.commands.registerCommand('gitvision._test.fileBlame', async (uri: vscode.Uri) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        const entry = blame?.store.get(doc);
        const outcome = entry && (await entry.promise);
        return { known: !!entry, coldMs: entry?.coldMs, failure: isFailure(outcome) ? outcome.code : null };
      }),
    );
  }
  log.info(`activated in ${activationMs.toFixed(1)} ms`);
}

export function deactivate() {}
