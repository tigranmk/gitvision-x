/**
 * Time-travel (spec F3): step a file through its revisions in place. Each revision opens as a read-only
 * gitvision: document in the same editor column, scrolled to the code the reader was on, with lines added
 * since the previous (or pinned) revision tinted and removed lines shown as red ghost text.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isCancelled, relativeTime, type FileRevision, type RevisionRef, type RevisionView } from '@gvx/protocol';
import type { WorkerPool } from '@gvx/git-engine';
import type { RepoRegistry } from '../repoRegistry';
import { parseRevisionUri, revisionUri } from './revisionUri';

const PREFETCH = 3;
const REMOVED_PREVIEW = 60;

export interface TimeTravelSession {
  root: string;
  /** The working-copy file the session started from. */
  workingUri: vscode.Uri;
  /** Repo-relative path of the working copy. */
  path: string;
  revisions: FileRevision[];
  /** Index into `revisions` shown now; -1 = the working copy. */
  index: number;
  /** Revision every step is diffed against instead of its predecessor. */
  pinned: RevisionRef | null;
  /** Index being loaded (partial clones fetch blobs on demand), or null. */
  loading: number | null;
  column: vscode.ViewColumn | undefined;
}

export class TimeTravelController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly removed = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'), margin: '0 0 0 3em', textDecoration: 'line-through; opacity: 0.8' },
    overviewRulerColor: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly _onDidChange = new vscode.EventEmitter<TimeTravelSession | null>();
  /** Fires on start, every step, pin changes and exit (null). */
  readonly onDidChange = this._onDidChange.event;
  session: TimeTravelSession | null = null;
  /** Decorations per revision document, re-applied when VS Code re-creates the editor. */
  private readonly shown = new Map<string, RevisionView>();
  private stepController: AbortController | null = null;
  /** For tests: the last step (command → editor shows the revision with its decorations). */
  lastStep: { index: number; ms: number; mappedLine: number | null; added: number; removed: number; uri: string } | null = null;
  /**
   * Top visible line per document, from our own reveals and the editor's scroll events. visibleRanges lags
   * a reveal by a frame or so, and stepping quickly (holding Alt+[) must not lose the reader's place.
   */
  private readonly top = new Map<string, number>();
  /** The working copy's view before the session started, restored on exit. */
  private savedRange: vscode.Range | undefined;

  constructor(
    private readonly pool: WorkerPool,
    private readonly repos: RepoRegistry,
  ) {
    this.disposables.push(
      this.added,
      this.removed,
      this._onDidChange,
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const e of editors) {
          const v = this.shown.get(e.document.uri.toString());
          if (v) this.decorate(e, v);
        }
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        const first = e.visibleRanges[0];
        if (first) this.top.set(e.textEditor.document.uri.toString(), first.start.line);
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        this.shown.delete(d.uri.toString());
        this.top.delete(d.uri.toString());
      }),
    );
  }

  /** Starts (or restarts) a session for the active editor's file. Resolves false if it is not in a repo. */
  async start(editor = vscode.window.activeTextEditor): Promise<boolean> {
    if (!editor) return false;
    const fromRevision = parseRevisionUri(editor.document.uri);
    if (fromRevision && this.session) return true; // already travelling in this file
    const file = this.repos.fileOf(editor.document.uri);
    if (!file) {
      void vscode.window.showInformationMessage('Time travel works on files in a git repository.');
      return false;
    }
    const root = file.session.root;
    const revisions = await this.pool.request('file.revisions', { root, path: file.path }, { affinity: root });
    if (!revisions.length) {
      void vscode.window.showInformationMessage(`${path.basename(file.path)} has no committed history yet.`);
      return false;
    }
    this.savedRange = editor.visibleRanges[0];
    this.session = { root, workingUri: editor.document.uri, path: file.path, revisions, index: -1, pinned: null, loading: null, column: editor.viewColumn };
    await vscode.commands.executeCommand('setContext', 'gitvision.timeTravel.active', true);
    this._onDidChange.fire(this.session);
    return true;
  }

  /** Shows revision `index` (clamped); -1 returns to the working copy. */
  async go(index: number): Promise<void> {
    const s = this.session;
    if (!s) return;
    if (index < 0) return this.exit();
    index = Math.min(index, s.revisions.length - 1);
    const started = performance.now();
    const rev = toRef(s.revisions[index]!);
    const against = s.pinned ?? (s.revisions[index + 1] ? toRef(s.revisions[index + 1]!) : null);
    const from = this.currentPosition();

    this.stepController?.abort();
    const controller = new AbortController();
    this.stepController = controller;
    s.loading = index;
    this._onDidChange.fire(s);
    let view: RevisionView;
    try {
      view = await this.pool.request('file.revision', { root: s.root, rev, against, mapFrom: from }, { affinity: s.root, signal: controller.signal });
    } catch (e) {
      if (isCancelled(e) || this.stepController !== controller) return;
      s.loading = null;
      this._onDidChange.fire(s);
      void vscode.window.showErrorMessage(`Time travel: ${(e as Error).message}`);
      return;
    }
    if (this.stepController !== controller || this.session !== s) return;

    const uri = revisionUri(s.root, rev);
    this.shown.set(uri.toString(), view);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: s.column, preview: true, preserveFocus: false });
    if (this.stepController !== controller) return;
    const line = Math.max(0, Math.min(view.mappedLine ?? 0, doc.lineCount - 1));
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
    this.top.set(uri.toString(), line);
    this.decorate(editor, view);
    s.index = index;
    s.loading = null;
    this.lastStep = {
      index,
      ms: performance.now() - started,
      mappedLine: view.mappedLine,
      added: view.added.length,
      removed: view.removed.reduce((n, r) => n + r.lines.length, 0),
      uri: uri.toString(),
    };
    this._onDidChange.fire(s);
    this.prefetch(s, index);
  }

  step(delta: number): Promise<void> {
    const s = this.session;
    // Back in time = higher index (revisions are newest first); from the working copy, back goes to the newest.
    if (!s) return Promise.resolve();
    return this.go(Math.max(-1, Math.min(s.revisions.length - 1, s.index - delta)));
  }

  /** Pins the revision shown (or unpins): later steps diff against it instead of their predecessor. */
  togglePin(): void {
    const s = this.session;
    if (!s) return;
    const cur = s.revisions[s.index];
    s.pinned = s.pinned || !cur ? null : toRef(cur);
    this._onDidChange.fire(s);
    if (s.index >= 0) void this.go(s.index);
  }

  /** Back to the live file, where the reader was before travelling. */
  async exit(): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.stepController?.abort();
    this.session = null;
    await vscode.commands.executeCommand('setContext', 'gitvision.timeTravel.active', false);
    // Close the revision tab (a preview tab, so at most one), then show the working copy again.
    for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
      if (tab.input instanceof vscode.TabInputText && parseRevisionUri(tab.input.uri)?.root === s.root) await vscode.window.tabGroups.close(tab);
    }
    const editor = await vscode.window.showTextDocument(s.workingUri, { viewColumn: s.column, preview: false });
    if (this.savedRange) editor.revealRange(this.savedRange, vscode.TextEditorRevealType.AtTop);
    this._onDidChange.fire(null);
  }

  /** The revision documents' hover: the full text of removed lines (ghost text shows a preview). */
  removedAt(uri: vscode.Uri, line: number): string[] | undefined {
    return this.shown.get(uri.toString())?.removed.find((r) => Math.max(0, r.after) === line)?.lines;
  }

  private decorate(editor: vscode.TextEditor, view: RevisionView): void {
    const doc = editor.document;
    const last = Math.max(0, doc.lineCount - 1);
    editor.setDecorations(
      this.added,
      view.added.filter((l) => l <= last).map((l) => new vscode.Range(l, 0, l, 0)),
    );
    editor.setDecorations(
      this.removed,
      view.removed.map((r) => {
        const line = Math.min(Math.max(0, r.after), last);
        const first = r.lines[0]!.trim();
        const text = `− ${first.length > REMOVED_PREVIEW ? `${first.slice(0, REMOVED_PREVIEW - 1)}…` : first}${r.lines.length > 1 ? `  (+${r.lines.length - 1} more removed)` : ''}`;
        const end = doc.lineAt(line).range.end;
        return { range: new vscode.Range(end, end), renderOptions: { after: { contentText: text } } };
      }),
    );
  }

  /** Where the reader is now: a revision and its top visible line, or the working copy's text. */
  private currentPosition(): ({ line: number } & (RevisionRef | { text: string })) | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const line = this.top.get(editor.document.uri.toString()) ?? editor.visibleRanges[0]?.start.line ?? editor.selection.active.line;
    const r = parseRevisionUri(editor.document.uri);
    if (r) return { line, ...r.rev };
    if (this.session && editor.document.uri.toString() === this.session.workingUri.toString()) return { line, text: editor.document.getText() };
    return undefined;
  }

  /** Warms the worker's blob cache for the revisions either side (spec: ±3). */
  private prefetch(s: TimeTravelSession, index: number): void {
    const revs: RevisionRef[] = [];
    for (let i = Math.max(0, index - PREFETCH); i <= Math.min(s.revisions.length - 1, index + PREFETCH + 1); i++) revs.push(toRef(s.revisions[i]!));
    void this.pool.request('file.prefetch', { root: s.root, revs }, { affinity: s.root }).catch(() => {});
  }

  /** Title for a revision: "abc1234 · Fix x · Ann, 3 days ago". */
  static label(r: FileRevision, nowSec = Math.floor(Date.now() / 1000)): string {
    return `${r.sha.slice(0, 7)} · ${r.subject} · ${r.author}, ${relativeTime(r.time, nowSec)}`;
  }

  dispose(): void {
    this.stepController?.abort();
    for (const d of this.disposables) d.dispose();
  }
}

const toRef = (r: FileRevision): RevisionRef => ({ sha: r.sha, path: r.path });
