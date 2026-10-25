/**
 * The graph webview, hosted as a WebviewView in the panel and, on demand, as a WebviewPanel beside
 * the editor (spec F2). Both talk to the host over the same RPC as the workers; the host proxies
 * graph pages from the index worker and pushes `graph.reset` when the repo shown or its history changes.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  RpcEndpoint,
  RpcError,
  type EventMap,
  type GraphHostEvents,
  type GraphHostMethods,
  type GraphState,
  type NoMethods,
  type Transport,
} from '@gvx/protocol';
import type { WorkerPool } from '@gvx/git-engine';
import type { RepoRegistry } from '../repoRegistry';
import type { SelectionStore } from '../selectionStore';
import { webviewHtml } from './html';

export const GRAPH_VIEW_ID = 'gitvision.graph';
const PANEL_TYPE = 'gitvision.graphPanel';

type Rpc = RpcEndpoint<GraphHostMethods, NoMethods, GraphHostEvents, EventMap>;

export class GraphViews implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly clients = new Set<Rpc>();
  private readonly disposables: vscode.Disposable[] = [];
  private shown: string | null = null;
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly pool: WorkerPool,
    private readonly repos: RepoRegistry,
    private readonly selection: SelectionStore,
  ) {
    this.shown = this.pickRoot();
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(GRAPH_VIEW_ID, this),
      vscode.commands.registerCommand('gitvision.graph.openBeside', () => this.openBeside()),
      this.selection.onDidChange(({ changed }) => {
        if (changed.includes('repo')) this.follow();
      }),
      repos.onDidOpen(() => this.follow()),
      repos.onDidClose(() => this.follow()),
      repos.onDidSync(({ stats }) => {
        // Any sync that replaced the table (not 'unchanged') shifts rows: the webview drops its pages.
        if (stats.root === this.shown && stats.mode !== 'unchanged') this.broadcast();
      }),
    );
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
    rpc.handle('graph.state', () => this.state());
    rpc.handle('graph.page', ({ root, start, count }, { signal }) => {
      if (root !== this.shown) throw new RpcError(`Graph moved on from ${root}`, 'stale');
      return this.pool.request('graph.page', { root, start, count }, { affinity: root, signal });
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
    const state = this.state();
    for (const c of this.clients) c.emit('graph.reset', state);
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
