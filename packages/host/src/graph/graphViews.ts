/**
 * The graph webview, hosted as a WebviewView in the panel and, on demand, as a WebviewPanel beside
 * the editor (spec F2). Both talk to the host over the same RPC as the workers; the host proxies
 * graph pages from the index worker and pushes `graph.reset` when the repo shown or its history changes.
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { RpcEndpoint, isCancelled, type GraphHostEvents, type GraphHostMethods, type GraphState, type GraphSync, type Transport } from '@gvx/protocol';
import type { WorkerPool } from '@gvx/git-engine';
import type { BlameController } from '../blame/blameController';
import type { GitAPI } from '../gitApi';
import { gitUri } from '../gitUri';
import { IDLE_MS } from '../blame/blameController';
import type { RepoRegistry } from '../repoRegistry';
import type { SelectionStore } from '../selectionStore';
import { webviewHtml } from './html';
import type { GraphActions } from './actions';
import { registerGraphMethods, type GraphRpc } from './methods';

export const GRAPH_VIEW_ID = 'gitvision.graph';
const PANEL_TYPE = 'gitvision.graphPanel';
/** Stage 2 outlines at most this many commits of the line's history. */
const LINEAGE_MAX = 500;

type Rpc = GraphRpc;

export class GraphViews implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly clients = new Set<Rpc>();
  private readonly disposables: vscode.Disposable[] = [];
  private shown: string | null = null;
  private panel: vscode.WebviewPanel | undefined;
  private sync: GraphSync | null = null;
  private syncSeq = 0;
  /** Cursor line (file + HEAD line) the current sync and lineage belong to. */
  private syncKey: string | null = null;
  private lineage: { key: string; controller: AbortController } | null = null;
  private lineageTimer: ReturnType<typeof setTimeout> | undefined;
  /** For tests: the last stage-1 sync (cursor event → event pushed) and stage-2 lineage. */
  lastSync: { sha: string | null; seq: number; ms: number } | null = null;
  lastLineage: { seq: number; shas: string[]; ms: number } | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly pool: WorkerPool,
    private readonly repos: RepoRegistry,
    private readonly selection: SelectionStore,
    private readonly blame: () => BlameController | undefined,
    private readonly gitApi: () => GitAPI | undefined,
    private readonly actions: GraphActions,
  ) {
    this.shown = this.pickRoot();
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(GRAPH_VIEW_ID, this),
      vscode.commands.registerCommand('gitvision.graph.openBeside', () => this.openBeside()),
      this.selection.onDidChange(({ changed }) => {
        if (changed.includes('repo')) this.follow();
        if ((changed.includes('file') || changed.includes('repo')) && this.shown) this.emit('graph.activeFile', { root: this.shown, path: this.activeFile() });
        // 'commit' is set when the ghost text renders: a fallback for lines the cache could not answer at once.
        if (changed.includes('line') || changed.includes('file') || changed.includes('commit')) this.syncToCursor();
      }),
      repos.onDidOpen(() => this.follow()),
      repos.onDidClose(() => this.follow()),
      repos.onDidSync(({ stats }) => {
        // Any sync that replaced the table (not 'unchanged') shifts rows: the webview drops its pages.
        if (stats.root !== this.shown) return;
        if (stats.mode !== 'unchanged') this.broadcast();
        else this.emit('graph.refresh', { root: stats.root }); // a checkout can move HEAD between existing tips
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        if (this.shown) this.emit('graph.openFiles', { root: this.shown, paths: this.openFiles(this.shown) });
      }),
      { dispose: () => this.cancelLineage() },
    );
  }

  /** Blame for a file landed or streamed in: the cursor line may be answerable now. */
  blameLoaded(): void {
    if (!this.sync) this.syncToCursor();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.attach(view.webview, view);
  }

  openBeside(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      PANEL_TYPE,
      'Git Graph',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { retainContextWhenHidden: false },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'graph.svg');
    panel.onDidDispose(() => (this.panel = undefined));
    this.panel = panel;
    this.attach(panel.webview, panel);
  }

  /** For tests: the state webviews are shown. */
  state(): GraphState {
    const session = this.shown ? this.repos.all().find((s) => s.root === this.shown) : undefined;
    return {
      root: session?.root ?? null,
      total: session?.lastStats?.commitCount ?? 0,
      userEmail: session?.info.userEmail ?? null,
      sync: this.sync,
      activeFile: this.activeFile(),
    };
  }

  dispose(): void {
    for (const c of this.clients) c.dispose();
    this.clients.clear();
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }

  private attach(webview: vscode.Webview, owner: { onDidDispose: vscode.Event<void> }): void {
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webviews', 'graph');
    webview.options = { enableScripts: true, localResourceRoots: [root] };
    const transport: Transport = {
      post: (msg) => void webview.postMessage(msg),
      onMessage: (handler) => {
        const sub = webview.onDidReceiveMessage(handler);
        return () => sub.dispose();
      },
    };
    const rpc: Rpc = new RpcEndpoint(transport);
    registerGraphMethods(rpc, {
      pool: this.pool,
      state: () => this.state(),
      shown: () => this.shown,
      openFiles: (root) => this.openFiles(root),
      writeClipboard: (text) => vscode.env.clipboard.writeText(text),
      openDiff: (a) => this.openDiff(a),
      dropBranch: (a) => this.actions.dropBranch(a),
      fetchMore: (root) => this.actions.fetchMore(root),
    });
    this.clients.add(rpc);
    owner.onDidDispose(() => {
      this.clients.delete(rpc);
      rpc.dispose();
    });
    webview.html = html(webview, root);
  }

  /** The repo of the active editor; otherwise keep the one shown, or the first open repo. */
  private pickRoot(): string | null {
    const roots = this.repos.all().map((s) => s.root);
    const active = this.selection.get().repo;
    if (active && roots.includes(active)) return active;
    if (this.shown && roots.includes(this.shown)) return this.shown;
    return roots[0] ?? null;
  }

  private follow(): void {
    const next = this.pickRoot();
    const session = next ? this.repos.all().find((s) => s.root === next) : undefined;
    if (next === this.shown) return;
    this.shown = next;
    this.broadcast();
    // The total is known once the first sync lands; reset again then.
    void session?.whenIndexed.then(() => {
      if (this.shown === next) this.broadcast();
    });
  }

  private broadcast(): void {
    // Rows shift when the table is replaced: drop the sync, push the reset, then sync again.
    this.sync = null;
    this.syncKey = null;
    this.cancelLineage();
    const state = this.state();
    for (const c of this.clients) c.emit('graph.reset', state);
    this.syncToCursor();
  }

  /**
   * Stage 1 (D1): pulse the commit that last touched the cursor line, straight from the blame cache.
   * Stage 2 starts after the cursor rests: the line's full lineage, outlined when the worker has it.
   */
  private syncToCursor(): void {
    const started = performance.now();
    const editor = vscode.window.activeTextEditor;
    const root = this.shown;
    if (!editor || !root) return;
    const line = editor.selection.active.line;
    const c = this.blame()?.lineCommit(editor, line);
    if (c === undefined) return; // not known without a round trip; the ghost text render re-triggers this
    if (c === null || c.root !== root) {
      this.cancelLineage();
      this.syncKey = null;
      if (this.sync) {
        this.sync = null;
        this.lastSync = { sha: null, seq: this.syncSeq, ms: performance.now() - started };
        this.emit('graph.sync', null);
      }
      return;
    }
    const key = `${c.path}:${c.headLine}`;
    if (key === this.syncKey && this.sync?.sha === c.sha) return;
    this.syncKey = key;
    this.scheduleLineage(c.root, c.path, c.headLine, key);
    if (this.sync?.sha === c.sha) return; // same commit, another of its lines: no new pulse

    this.sync = { sha: c.sha, seq: ++this.syncSeq };
    this.lastSync = { sha: c.sha, seq: this.sync.seq, ms: performance.now() - started };
    this.emit('graph.sync', this.sync);
  }

  private scheduleLineage(root: string, path: string, headLine: number, key: string): void {
    this.cancelLineage();
    this.lineageTimer = setTimeout(() => {
      const controller = new AbortController();
      this.lineage = { key, controller };
      const started = performance.now();
      void this.pool
        .request('blame.lineHistory', { root, path, line: headLine + 1, count: LINEAGE_MAX }, { affinity: root, signal: controller.signal })
        .then(
          (history) => {
            if (this.lineage?.controller !== controller || !this.sync) return;
            const shas = history.map((h) => h.sha);
            this.lastLineage = { seq: this.sync.seq, shas, ms: performance.now() - started };
            this.emit('graph.lineage', { seq: this.sync.seq, shas });
          },
          (e) => {
            if (!isCancelled(e)) this.lastLineage = { seq: this.sync?.seq ?? -1, shas: [], ms: performance.now() - started };
          },
        );
    }, IDLE_MS);
  }

  private cancelLineage(): void {
    clearTimeout(this.lineageTimer);
    this.lineage?.controller.abort();
    this.lineage = null;
  }

  /** VS Code's diff editor for one file of a commit; added and deleted files open the one side that exists. */
  async openDiff(a: GraphHostMethods['graph.openDiff']['params']): Promise<void> {
    const api = this.gitApi();
    if (!api) return void vscode.window.showWarningMessage('GitVision needs the built-in Git extension to open diffs.');
    const at = (file: string, ref: string) => gitUri(api, a.root, file, ref);
    const short = a.sha.slice(0, 7);
    const name = path.basename(a.file.path);
    if (a.file.status === 'D' && a.parent) {
      await vscode.commands.executeCommand('vscode.open', at(a.file.oldPath ?? a.file.path, a.parent), { preview: true }, `${name} (deleted in ${short})`);
    } else if (a.file.status === 'A' || !a.parent) {
      await vscode.commands.executeCommand('vscode.open', at(a.file.path, a.sha), { preview: true }, `${name} (added in ${short})`);
    } else {
      const title = `${name} (${a.parent.slice(0, 7)} ↔ ${short})`;
      await vscode.commands.executeCommand('vscode.diff', at(a.file.oldPath ?? a.file.path, a.parent), at(a.file.path, a.sha), title, { preview: true });
    }
  }

  /** Repo-relative paths of files open in editor tabs (text and diff editors). */
  private openFiles(root: string): string[] {
    const paths = new Set<string>();
    for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
      const uris =
        tab.input instanceof vscode.TabInputText ? [tab.input.uri] : tab.input instanceof vscode.TabInputTextDiff ? [tab.input.modified] : [];
      for (const uri of uris) {
        const f = this.repos.fileOf(uri);
        if (f && f.session.root === root) paths.add(f.path);
      }
    }
    return [...paths];
  }

  private activeFile(): string | null {
    const sel = this.selection.get();
    return sel.repo === this.shown ? sel.file : null;
  }

  private emit<E extends 'graph.sync' | 'graph.lineage' | 'graph.openFiles' | 'graph.refresh' | 'graph.activeFile'>(event: E, data: GraphHostEvents[E]): void {
    for (const c of this.clients) c.emit(event, data);
  }
}

function html(webview: vscode.Webview, root: vscode.Uri): string {
  return webviewHtml({
    cspSource: webview.cspSource,
    nonce: randomBytes(16).toString('base64'),
    asset: (name) => webview.asWebviewUri(vscode.Uri.joinPath(root, name)).toString(),
    name: 'graph',
    title: 'Git Graph',
  });
}
