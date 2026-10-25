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
import { ConflictController } from './conflicts/controller';
import { ConflictStore } from './conflicts/store';
import { GraphActions } from './graph/actions';
import { GraphViews } from './graph/graphViews';
import { registerTimeTravelCommands } from './timeTravel/commands';
import { TimeTravelController } from './timeTravel/controller';
import { registerRevisionFs } from './timeTravel/revisionFs';
import { TimelineView } from './timeTravel/timelineView';
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
  let timeTravel: TimeTravelController | undefined;
  let conflictStore: ConflictStore | undefined;
  let conflicts: ConflictController | undefined;

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
    conflictStore = new ConflictStore(pool, repos, context.workspaceState);
    conflicts = new ConflictController(context, pool, repos, conflictStore, () => gitApi);
    graph = new GraphViews(context.extensionUri, pool, repos, selection, () => blame, () => gitApi, actions, { store: conflictStore, controller: conflicts });
    timeTravel = new TimeTravelController(pool, repos);
    context.subscriptions.push(
      actions,
      registerRevisionFs(pool),
      timeTravel,
      registerTimeTravelCommands(timeTravel),
      new TimelineView(context.extensionUri, timeTravel, repos),
      // The pinned revision is the selection model's compareTo (spec: one selection model for every surface).
      timeTravel.onDidChange((s) => selection.update({ compareTo: s?.pinned?.sha ?? null })),
      conflictStore,
      conflicts,
      vscode.commands.registerCommand('gitvision._openCommit', (root: string, sha: string) => actions?.openCommit(root, sha)),
      vscode.commands.registerCommand('gitvision.graph.reveal', (a: { root: string; sha: string }) => graph?.reveal(a.root, a.sha)),
    );
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
      vscode.commands.registerCommand('gitvision._test.conflicts', async (root: string) => {
        const r = (await conflictStore?.refresh(root)) ?? null;
        return r && { op: r.state.op, oursLabel: r.state.oursLabel, theirsLabel: r.state.theirsLabel, rebase: r.state.rebase, files: r.state.files, progress: r.files, hunksTotal: r.hunksTotal, hunksResolved: r.hunksResolved, lastWrite: conflicts?.lastWrite };
      }),
      vscode.commands.registerCommand('gitvision._test.conflictLenses', async (uri: vscode.Uri) => {
        const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri, 50)) ?? [];
        return lenses.filter((l) => l.command?.command.startsWith('gitvision.conflicts') || l.command?.command === '').map((l) => ({ line: l.range.start.line, title: l.command?.title }));
      }),
      vscode.commands.registerCommand('gitvision._test.runOperation', (root: string, choice: 'continue' | 'skip' | 'abort') => conflicts?.runOperation(root, choice)),
      vscode.commands.registerCommand('gitvision._test.openRepo', (dir: string) => repos.open(dir)),
      vscode.commands.registerCommand('gitvision._test.timeTravel', () => ({
        session: timeTravel?.session && {
          root: timeTravel.session.root,
          path: timeTravel.session.path,
          index: timeTravel.session.index,
          count: timeTravel.session.revisions.length,
          pinned: timeTravel.session.pinned,
        },
        lastStep: timeTravel?.lastStep,
      })),
      vscode.commands.registerCommand('gitvision._test.openCommit', (root: string, sha: string) => actions?.openCommit(root, sha)),
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
        // Follow replacements: a HEAD move invalidates the repo's blame (the old request ends 'cancelled')
        // and the file is blamed again; report the entry that is current once it settles.
        for (;;) {
          const entry = blame?.store.get(doc);
          const outcome = entry && (await entry.promise);
          if (entry && blame?.store.get(doc) !== entry) continue;
          return { known: !!entry, coldMs: entry?.coldMs, failure: isFailure(outcome) ? outcome.code : null };
        }
      }),
    );
  }
  log.info(`activated in ${activationMs.toFixed(1)} ms`);
}

export function deactivate() {}
