/**
 * F1 Intelligent inline blame: one ghost-text annotation on the active line after 250 ms of cursor
 * idle, a hover with the line's history, and optional gutter heatmap / status-bar author.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isCancelled, type LineHistoryEntry } from '@gvx/protocol';
import type { WorkerPool } from '@gvx/git-engine';
import type { GitAPI } from '../gitApi';
import type { RepoRegistry } from '../repoRegistry';
import type { SelectionStore } from '../selectionStore';
import { BlameStore, isFailure, type FileBlame } from './blameStore';
import { aggregate, aggregateText, ageBucket, ghostText, lineBlame, type LineBlame } from './format';
import { blameHover, type DiffArgs } from './hover';

export const IDLE_MS = 250;
const HISTORY_COUNT = 10;

export interface RenderRecord {
  uri: string;
  line: number;
  text: string;
  /** Idle timer fired → decoration set. */
  ms: number;
  /** True when everything was cached (no worker round trip). */
  warm: boolean;
}

interface Config {
  enabled: boolean;
  heatmap: boolean;
  statusBar: boolean;
}
const readConfig = (): Config => {
  const c = vscode.workspace.getConfiguration('gitvision.blame');
  return { enabled: c.get('enabled', true), heatmap: c.get('gutterHeatmap', false), statusBar: c.get('statusBar', false) };
};

const nowSec = () => Math.floor(Date.now() / 1000);

export class BlameController implements vscode.Disposable {
  readonly store: BlameStore;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly ghost = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 3em', textDecoration: 'none; opacity: 0.6' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  /** Gutter heatmap, newest (0) → oldest (4). Created in the constructor: it needs `context`. */
  private readonly heat: vscode.TextEditorDecorationType[];
  private readonly statusItem = vscode.window.createStatusBarItem('gitvision.blame', vscode.StatusBarAlignment.Right, 100);
  private config = readConfig();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped on every cursor/edit event; a render finishing with a stale token is dropped. */
  private token = 0;
  /** Set when the idle render ran but the cursor line was not attributed yet (D11a). */
  private waiting: number | undefined;
  private renderStarted = 0;
  private decorated: vscode.TextEditor | undefined;
  private rendered: { uri: string; line: number; info: LineBlame; entry: FileBlame } | undefined;
  private history: { key: string; controller: AbortController; promise: Promise<LineHistoryEntry[] | null> } | undefined;
  lastRender: RenderRecord | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly pool: WorkerPool,
    private readonly repos: RepoRegistry,
    private readonly selection: SelectionStore,
    private readonly gitApi: () => GitAPI | undefined,
    log: vscode.LogOutputChannel,
  ) {
    this.store = new BlameStore(pool, repos, context.globalStorageUri.fsPath, log);
    this.heat = [0, 1, 2, 3, 4].map((i) =>
      vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', `heat-${i}.svg`),
        gutterIconSize: 'contain',
      }),
    );
    this.statusItem.name = 'GitVision Blame';
    this.disposables.push(
      this.store,
      this.ghost,
      ...this.heat,
      this.statusItem,
      vscode.window.onDidChangeVisibleTextEditors(() => this.prefetchVisible()),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) this.schedule();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!e.contentChanges.length) return;
        // Hide while typing; the next idle render remaps the edited buffer.
        if (this.decorated?.document === e.document) this.clear();
        if (vscode.window.activeTextEditor?.document === e.document) this.schedule();
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.store.forget(d)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('gitvision.blame')) return;
        this.config = readConfig();
        this.clear();
        this.refreshHeatmaps();
        this.schedule();
      }),
      repos.onDidOpen((session) => {
        // Spawn the blame worker and cache the repo layout now, not on the first file's critical path.
        void this.pool.request('blame.warm', { root: session.root }, { affinity: session.root }).catch(() => {});
        this.prefetchVisible();
      }),
      repos.onDidSync(({ session, stats }) => {
        if (!stats.refsChanged) return;
        this.store.invalidateRepo(session.root);
        this.prefetchVisible();
        this.schedule();
      }),
      this.store.onDidLoad((entry) => {
        this.refreshHeatmaps(entry);
        this.resumeIfWaiting(entry);
      }),
      this.store.onDidProgress((entry) => this.resumeIfWaiting(entry)),
      vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover: (d, p, t) => this.provideHover(d, p, t) }),
      vscode.commands.registerCommand('gitvision.blame.openCommitDiff', (a: DiffArgs) => this.openDiff(a)),
      vscode.commands.registerCommand('gitvision.blame.copySha', async (sha: string) => {
        await vscode.env.clipboard.writeText(sha);
        vscode.window.setStatusBarMessage(`$(check) Copied ${sha.slice(0, 7)}`, 2000);
      }),
      vscode.commands.registerCommand('gitvision.blame.blameFile', () => {
        const doc = vscode.window.activeTextEditor?.document;
        if (doc && this.store.ensure(doc, { force: true })) this.schedule(0);
      }),
      vscode.commands.registerCommand('gitvision.blame.toggle', () =>
        vscode.workspace.getConfiguration('gitvision.blame').update('enabled', !this.config.enabled, vscode.ConfigurationTarget.Global),
      ),
    );
    this.prefetchVisible();
    this.schedule();
  }

  /** D10: blame starts when a file becomes visible, not when the cursor stops. */
  private prefetchVisible(): void {
    if (!this.config.enabled) return;
    for (const e of vscode.window.visibleTextEditors) {
      const entry = this.store.ensure(e.document);
      // Warm the line map for the current version as soon as blame lands.
      void entry?.promise.then(() => {
        try {
          void Promise.resolve(this.store.mapFor(entry, e.document)).catch(() => {});
        } catch {
          /* document closed */
        }
      });
    }
  }

  private schedule(delay = IDLE_MS): void {
    this.token++;
    clearTimeout(this.timer);
    if (this.rendered && this.rendered.line !== vscode.window.activeTextEditor?.selection.active.line) this.clear();
    this.timer = setTimeout(() => void this.render(), delay);
  }

  private clear(): void {
    this.decorated?.setDecorations(this.ghost, []);
    this.decorated = undefined;
    this.rendered = undefined;
    this.statusItem.hide();
  }

  private async render(): Promise<void> {
    const t0 = performance.now();
    const token = this.token;
    if (this.waiting !== token) this.renderStarted = t0;
    const editor = vscode.window.activeTextEditor;
    if (!this.config.enabled || !editor) return this.clear();
    const doc = editor.document;
    const entry = this.store.ensure(doc);
    if (!entry) {
      this.selection.update({ commit: null });
      return this.clear();
    }
    const view = this.store.view(entry);
    if (!view) return this.wait(token); // nothing streamed yet
    if (isFailure(view) && view.code !== 'not-tracked') return this.clear();
    let warm = !!entry.outcome && this.waiting !== token;

    let map: Int32Array | null = null;
    if (!isFailure(view)) {
      const m = this.store.mapFor(entry, doc);
      if (m instanceof Promise) {
        warm = false;
        try {
          map = await m;
        } catch (e) {
          if (!isCancelled(e)) this.clear();
          return;
        }
        if (token !== this.token) return;
      } else {
        map = m;
      }
    }

    const sel = editor.selection;
    const line = sel.active.line;
    const infoAt = (l: number): LineBlame => (isFailure(view) ? { kind: 'uncommitted' } : lineBlame(view, map, l));
    const info = infoAt(line);
    const email = entry.session.info.userEmail;
    const locale = vscode.env.language;
    let text: string;
    const last = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
    if (last > sel.start.line) {
      const infos: LineBlame[] = [];
      for (let l = sel.start.line; l <= last; l++) infos.push(infoAt(l));
      if (infos.some((i) => i.kind === 'pending')) return this.wait(token);
      text = aggregateText(aggregate(infos, email), nowSec(), locale);
    } else {
      if (info.kind === 'pending') return this.wait(token);
      text = ghostText(info, email, nowSec(), locale);
    }
    this.waiting = undefined;

    const end = doc.lineAt(line).range.end;
    if (this.decorated && this.decorated !== editor) this.decorated.setDecorations(this.ghost, []);
    editor.setDecorations(this.ghost, [{ range: new vscode.Range(end, end), renderOptions: { after: { contentText: text } } }]);
    this.decorated = editor;
    this.rendered = { uri: entry.key, line, info, entry };
    this.lastRender = { uri: entry.key, line, text, ms: performance.now() - (warm ? t0 : this.renderStarted), warm };
    this.selection.update({ commit: info.kind === 'commit' ? info.commit.sha : null });

    if (this.config.statusBar && info.kind === 'commit') {
      this.statusItem.text = `$(person) ${text.split(' • ')[0]}`;
      this.statusItem.tooltip = info.commit.summary;
      this.statusItem.show();
    } else {
      this.statusItem.hide();
    }
    this.preloadHistory(entry, info);
  }

  /** The cursor line is not attributed yet: render again as entries stream in. */
  private wait(token: number): void {
    this.waiting = token;
    if (this.decorated) this.clear();
  }

  private resumeIfWaiting(entry: FileBlame): void {
    if (this.waiting === undefined || this.waiting !== this.token) return;
    if (vscode.window.activeTextEditor?.document.uri.toString() !== entry.key) return;
    void this.render();
  }

  /** Spec risk: the hover must open fast, so line history loads on cursor idle. */
  private preloadHistory(entry: FileBlame, info: LineBlame): void {
    if (info.kind !== 'commit') return;
    const key = `${entry.key}#${info.headLine}#${entry.blobSha ?? ''}`;
    if (this.history?.key === key) return;
    this.history?.controller.abort();
    const controller = new AbortController();
    const root = entry.session.root;
    const promise = this.pool
      .request('blame.lineHistory', { root, path: entry.path, line: info.headLine + 1, count: HISTORY_COUNT }, { affinity: root, signal: controller.signal })
      .catch(() => null);
    this.history = { key, controller, promise };
  }

  private async provideHover(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    const r = this.rendered;
    // Only on the annotation itself: the rendered line, past the end of its text.
    if (!r || r.uri !== doc.uri.toString() || pos.line !== r.line || pos.character < doc.lineAt(pos.line).text.length) return undefined;
    const history = this.history && r.info.kind === 'commit' ? await this.history.promise : null;
    if (token.isCancellationRequested) return undefined;
    const md = blameHover({
      info: r.info,
      root: r.entry.session.root,
      path: r.entry.path,
      userEmail: r.entry.session.info.userEmail,
      history,
      nowSec: nowSec(),
      locale: vscode.env.language,
    });
    return new vscode.Hover(md, new vscode.Range(pos, pos));
  }

  private refreshHeatmaps(only?: FileBlame): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (!this.config.heatmap) {
        for (const h of this.heat) editor.setDecorations(h, []);
        continue;
      }
      const entry = this.store.get(editor.document);
      if (!entry?.outcome || isFailure(entry.outcome) || (only && only !== entry)) continue;
      const outcome = { ...entry.outcome, complete: true };
      void Promise.resolve(this.store.mapFor(entry, editor.document)).then(
        (map) => {
          const buckets: vscode.Range[][] = [[], [], [], [], []];
          const now = nowSec();
          for (let l = 0; l < editor.document.lineCount; l++) {
            buckets[ageBucket(lineBlame(outcome, map, l), now)]!.push(new vscode.Range(l, 0, l, 0));
          }
          this.heat.forEach((h, i) => editor.setDecorations(h, buckets[i]!));
        },
        () => {},
      );
    }
  }

  private async openDiff(a: DiffArgs): Promise<void> {
    const api = this.gitApi();
    const right = vscode.Uri.file(path.join(a.root, a.path));
    if (!api) return void vscode.window.showWarningMessage('GitVision needs the built-in Git extension to open diffs.');
    const title = `${path.basename(a.path)} (${a.sha.slice(0, 7)})`;
    if (a.prev) {
      const left = vscode.Uri.file(path.join(a.root, a.prev.path));
      await vscode.commands.executeCommand('vscode.diff', api.toGitUri(left, a.prev.sha), api.toGitUri(right, a.sha), title);
    } else {
      // No previous revision known (root commit, or history entry): diff against the parent.
      await vscode.commands.executeCommand('vscode.diff', api.toGitUri(right, `${a.sha}^`), api.toGitUri(right, a.sha), title);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.history?.controller.abort();
    for (const d of this.disposables) d.dispose();
  }
}
