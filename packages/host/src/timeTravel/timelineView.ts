/**
 * The time-travel timeline (spec F3, D3: a view in the panel; the editor-title QuickPick is the fallback).
 * It drives the same TimeTravelController as the commands.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { RpcEndpoint, type EventMap, type NoMethods, type TimelineHostEvents, type TimelineHostMethods, type TimelinePosition, type Transport } from '@gvx/protocol';
import { webviewHtml } from '../graph/html';
import type { RepoRegistry } from '../repoRegistry';
import type { TimeTravelController } from './controller';
import { parseRevisionUri } from './revisionUri';

export const TIMELINE_VIEW_ID = 'gitvision.timeline';
type Rpc = RpcEndpoint<TimelineHostMethods, NoMethods, TimelineHostEvents, EventMap>;

export class TimelineView implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly clients = new Set<Rpc>();
  private readonly disposables: vscode.Disposable[] = [];
  private sessionId = 0;
  private lastSession: unknown = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly tt: TimeTravelController,
    private readonly repos: RepoRegistry,
  ) {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(TIMELINE_VIEW_ID, this),
      tt.onDidChange((s) => {
        if (s && s !== this.lastSession) this.sessionId++;
        this.lastSession = s;
        this.push();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        if (!this.tt.session) this.push();
      }),
    );
  }

  position(): TimelinePosition {
    const s = this.tt.session;
    if (s) return { active: true, file: s.path, index: s.index, pinned: s.pinned?.sha ?? null, loading: s.loading, session: this.sessionId };
    const editor = vscode.window.activeTextEditor;
    const file = editor && !parseRevisionUri(editor.document.uri) ? this.repos.fileOf(editor.document.uri) : undefined;
    return { active: false, file: file?.path ?? null, index: -1, pinned: null, loading: null, session: this.sessionId };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webviews', 'timeline');
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    const transport: Transport = {
      post: (msg) => void view.webview.postMessage(msg),
      onMessage: (handler) => {
        const sub = view.webview.onDidReceiveMessage(handler);
        return () => sub.dispose();
      },
    };
    const rpc: Rpc = new RpcEndpoint(transport);
    rpc.handle('timeline.position', () => this.position());
    rpc.handle('timeline.revisions', () => {
      const s = this.tt.session;
      return s ? { session: this.sessionId, path: s.path, revisions: s.revisions } : null;
    });
    rpc.handle('timeline.start', async () => {
      // The view has focus when its button is clicked: start for the last active text editor.
      const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
      if (!(await this.tt.start(editor))) return false;
      await this.tt.go(0); // the newest revision: what changed last
      return true;
    });
    rpc.handle('timeline.go', async ({ session, index }) => {
      if (session === this.sessionId) await this.tt.go(index);
      return null;
    });
    rpc.handle('timeline.pin', () => {
      this.tt.togglePin();
      return null;
    });
    rpc.handle('timeline.pick', async () => {
      await vscode.commands.executeCommand('gitvision.timeTravel.pick');
      return null;
    });
    rpc.handle('timeline.exit', async () => {
      await this.tt.exit();
      return null;
    });
    this.clients.add(rpc);
    view.onDidDispose(() => {
      this.clients.delete(rpc);
      rpc.dispose();
    });
    view.webview.html = webviewHtml({
      cspSource: view.webview.cspSource,
      nonce: randomBytes(16).toString('base64'),
      asset: (name) => view.webview.asWebviewUri(vscode.Uri.joinPath(root, name)).toString(),
      name: 'timeline',
      title: 'Time Travel',
    });
  }

  private push(): void {
    const p = this.position();
    for (const c of this.clients) c.emit('timeline.position', p);
  }

  dispose(): void {
    for (const c of this.clients) c.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
