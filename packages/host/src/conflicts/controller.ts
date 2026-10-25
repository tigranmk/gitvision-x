/**
 * Conflicts in the editor (spec F4): each hunk is one block with a header row (Accept current / incoming /
 * both, pick lines, compare, explain) and an author chip per side; resolutions apply as one WorkspaceEdit
 * (one undo step). diff3 / zdiff3 base sections start folded. Files whose conflict is not in their text
 * (delete/modify, rename/rename, binary) get a file-level card. The status bar runs the operation:
 * Continue / Skip / Abort, with the rebase step counter.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { RpcError, relativeTime, type ConflictFile, type ExplainCommit, type RepoWriteOp } from '@gvx/protocol';
import type { WorkerPool } from '@gvx/git-engine';
import type { GitAPI } from '../gitApi';
import { gitUri } from '../gitUri';
import type { RepoRegistry } from '../repoRegistry';
import { confirm, pick } from '../ui';
import { parseConflicts, resolveHunk, type ConflictHunk } from './parser';
import type { ConflictStore, RepoConflicts } from './store';

export type Resolution = 'current' | 'incoming' | 'both';

const BUILTIN_ASKED = 'gitvision.mergeConflictCoexistenceAsked';

export class ConflictController implements vscode.Disposable, vscode.CodeLensProvider, vscode.FoldingRangeProvider {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly deco = {
    currentHeader: vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('merge.currentHeaderBackground') }),
    current: vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('merge.currentContentBackground') }),
    base: vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('merge.commonContentBackground'), opacity: '0.7' }),
    baseHeader: vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('merge.commonHeaderBackground') }),
    incoming: vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('merge.incomingContentBackground') }),
    incomingHeader: vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('merge.incomingHeaderBackground') }),
  };
  private readonly status = vscode.window.createStatusBarItem('gitvision.conflicts', vscode.StatusBarAlignment.Left, 50);
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  /** Explain results per (root, path, side, hunk text): the chip shows the newest commit. */
  private readonly explained = new Map<string, Promise<ExplainCommit[]>>();
  /** Documents whose base sections were folded once already. */
  private readonly folded = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly pool: WorkerPool,
    private readonly repos: RepoRegistry,
    private readonly store: ConflictStore,
    private readonly gitApi: () => GitAPI | undefined,
  ) {
    const selector: vscode.DocumentSelector = { scheme: 'file' };
    this.disposables.push(
      ...Object.values(this.deco),
      this.status,
      this._onDidChangeCodeLenses,
      vscode.languages.registerCodeLensProvider(selector, this),
      vscode.languages.registerFoldingRangeProvider(selector, this),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorateAll()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const ed = vscode.window.visibleTextEditors.filter((x) => x.document === e.document);
        ed.forEach((x) => this.decorate(x));
      }),
      store.onDidChange((r) => {
        this.updateStatus();
        this.decorateAll();
        this._onDidChangeCodeLenses.fire();
        if (r.state.op) void this.offerBuiltinCoexistence();
      }),
      vscode.commands.registerCommand('gitvision.conflicts.accept', (uri: vscode.Uri, start: number, how: Resolution) => this.accept(uri, start, how)),
      vscode.commands.registerCommand('gitvision.conflicts.acceptAll', (uri: vscode.Uri, how: Resolution) => this.acceptAll(uri, how)),
      vscode.commands.registerCommand('gitvision.conflicts.pickLines', (uri: vscode.Uri, start: number, picked?: number[]) => this.pickLines(uri, start, picked)),
      vscode.commands.registerCommand('gitvision.conflicts.compare', (uri: vscode.Uri, start: number) => this.compare(uri, start)),
      vscode.commands.registerCommand('gitvision.conflicts.explain', (uri: vscode.Uri, start: number) => this.explain(uri, start)),
      vscode.commands.registerCommand('gitvision.conflicts.openMergeEditor', (uri?: vscode.Uri) => this.openMergeEditor(uri)),
      vscode.commands.registerCommand('gitvision.conflicts.resolveFile', (root: string, file: string, how: 'keep' | 'delete' | 'ours' | 'theirs') => this.resolveFile(root, file, how)),
      vscode.commands.registerCommand('gitvision.conflicts.run', (root?: string) => this.runOperation(root)),
    );
    this.decorateAll();
  }

  // ---- in-editor blocks ----

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const ctx = this.contextOf(doc);
    if (!ctx) return [];
    const { r, file } = ctx;
    const lenses: vscode.CodeLens[] = [];
    const conflict = r.state.files.find((f) => f.path === file);
    if (conflict && conflict.kind !== 'content') return this.fileCard(doc, r, conflict);
    const ours = r.state.oursLabel || 'current';
    const theirs = r.state.theirsLabel || 'incoming';
    for (const h of parseConflicts(doc.getText())) {
      const at = new vscode.Range(h.start, 0, h.start, 0);
      const cmd = (title: string, command: string, args: unknown[], tooltip?: string) => new vscode.CodeLens(at, { title, command, arguments: args, tooltip });
      lenses.push(
        cmd(`Accept Current (${ours})`, 'gitvision.conflicts.accept', [doc.uri, h.start, 'current']),
        cmd(`Accept Incoming (${theirs})`, 'gitvision.conflicts.accept', [doc.uri, h.start, 'incoming']),
        cmd('Accept Both', 'gitvision.conflicts.accept', [doc.uri, h.start, 'both']),
        cmd('Pick Lines…', 'gitvision.conflicts.pickLines', [doc.uri, h.start], 'Choose lines from each side'),
        cmd('Compare', 'gitvision.conflicts.compare', [doc.uri, h.start], 'Diff the two sides'),
        cmd('$(question) Explain', 'gitvision.conflicts.explain', [doc.uri, h.start], 'Commits on each side that touched these lines'),
      );
      // Author chips, filled in by resolveCodeLens (one git log -L per side).
      for (const side of ['ours', 'theirs'] as const) {
        const lens = new vscode.CodeLens(at) as vscode.CodeLens & { chip?: { uri: vscode.Uri; start: number; side: 'ours' | 'theirs' } };
        lens.chip = { uri: doc.uri, start: h.start, side };
        lenses.push(lens);
      }
    }
    if (lenses.length && this.mergeEditorAvailable()) {
      lenses.unshift(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title: '$(merge) Open in 3-way Merge Editor', command: 'gitvision.conflicts.openMergeEditor', arguments: [doc.uri] }));
    }
    return lenses;
  }

  async resolveCodeLens(lens: vscode.CodeLens & { chip?: { uri: vscode.Uri; start: number; side: 'ours' | 'theirs' } }): Promise<vscode.CodeLens> {
    if (!lens.chip || lens.command) return lens;
    const { uri, start, side } = lens.chip;
    const commits = await this.explainSide(uri, start, side).catch(() => []);
    const c = commits[0];
    const label = side === 'ours' ? 'current' : 'incoming';
    lens.command = {
      title: c ? `$(account) ${label}: ${c.author}, ${relativeTime(c.time, Math.floor(Date.now() / 1000))} · ${c.sha.slice(0, 7)}` : `$(account) ${label}: no commits since the base`,
      tooltip: c ? `${c.subject}${commits.length > 1 ? `\n+${commits.length - 1} more on this side` : ''}` : undefined,
      command: 'gitvision.conflicts.explain',
      arguments: [uri, start],
    };
    return lens;
  }

  provideFoldingRanges(doc: vscode.TextDocument): vscode.FoldingRange[] {
    if (!this.contextOf(doc)) return [];
    return parseConflicts(doc.getText())
      .filter((h) => h.base && h.base.end > h.base.marker)
      .map((h) => new vscode.FoldingRange(h.base!.marker, h.base!.end - 1, vscode.FoldingRangeKind.Region));
  }

  private decorateAll(): void {
    for (const e of vscode.window.visibleTextEditors) this.decorate(e);
  }

  private decorate(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const hunks = this.contextOf(doc) ? parseConflicts(doc.getText()) : [];
    const lines = (from: number, to: number) => (to > from ? [new vscode.Range(from, 0, to - 1, 0)] : []);
    editor.setDecorations(this.deco.currentHeader, hunks.map((h) => new vscode.Range(h.start, 0, h.start, 0)));
    editor.setDecorations(this.deco.current, hunks.flatMap((h) => lines(h.current.start, h.current.end)));
    editor.setDecorations(this.deco.baseHeader, hunks.flatMap((h) => (h.base ? [new vscode.Range(h.base.marker, 0, h.base.marker, 0)] : [])));
    editor.setDecorations(this.deco.base, hunks.flatMap((h) => (h.base ? lines(h.base.start, h.base.end) : [])));
    editor.setDecorations(this.deco.incomingHeader, hunks.flatMap((h) => [new vscode.Range(h.incoming.marker, 0, h.incoming.marker, 0), new vscode.Range(h.end, 0, h.end, 0)]));
    editor.setDecorations(this.deco.incoming, hunks.flatMap((h) => lines(h.incoming.start, h.incoming.end)));
    // diff3 / zdiff3: the base section starts folded (once per document).
    const key = doc.uri.toString();
    const bases = hunks.filter((h) => h.base).map((h) => h.base!.marker);
    if (bases.length && !this.folded.has(key) && editor === vscode.window.activeTextEditor) {
      this.folded.add(key);
      void vscode.commands.executeCommand('editor.fold', { selectionLines: bases, levels: 1 });
    }
  }

  // ---- resolutions (one WorkspaceEdit each: one undo step) ----

  async accept(uri: vscode.Uri, start: number, how: Resolution): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const h = this.hunkAt(doc, start);
    if (!h) return false;
    return this.replaceHunk(doc, h, resolveHunk(lines(doc), h, how));
  }

  async acceptAll(uri: vscode.Uri, how: Resolution): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const all = lines(doc);
    const edit = new vscode.WorkspaceEdit();
    for (const h of parseConflicts(doc.getText())) edit.replace(uri, hunkRange(doc, h), join(doc, resolveHunk(all, h, how)));
    return vscode.workspace.applyEdit(edit);
  }

  /** Line-level picks: tick lines from either side; they replace the hunk in order, current side first. */
  async pickLines(uri: vscode.Uri, start: number, picked?: number[]): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const h = this.hunkAt(doc, start);
    if (!h) return false;
    const all = lines(doc);
    const r = this.contextOf(doc)?.r;
    type Item = vscode.QuickPickItem & { line?: number };
    const items: Item[] = [
      { label: `Current (${r?.state.oursLabel || 'ours'})`, kind: vscode.QuickPickItemKind.Separator },
      ...range(h.current.start, h.current.end).map((l) => ({ label: all[l]! || '(empty line)', line: l, picked: true })),
      { label: `Incoming (${r?.state.theirsLabel || 'theirs'})`, kind: vscode.QuickPickItemKind.Separator },
      ...range(h.incoming.start, h.incoming.end).map((l) => ({ label: all[l]! || '(empty line)', line: l, picked: false })),
    ];
    let chosen: number[] | undefined = picked;
    if (!chosen) {
      const result = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Lines to keep (current side first, then incoming)', matchOnDescription: true });
      chosen = result?.map((i) => i.line!).filter((l) => l !== undefined);
    }
    if (!chosen) return false;
    const keep = [...chosen].sort((a, b) => a - b).filter((l) => (l >= h.current.start && l < h.current.end) || (l >= h.incoming.start && l < h.incoming.end));
    return this.replaceHunk(doc, h, keep.map((l) => all[l]!));
  }

  private replaceHunk(doc: vscode.TextDocument, h: ConflictHunk, content: string[]): Thenable<boolean> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, hunkRange(doc, h), join(doc, content));
    return vscode.workspace.applyEdit(edit);
  }

  private async compare(uri: vscode.Uri, start: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const h = this.hunkAt(doc, start);
    if (!h) return;
    const all = lines(doc);
    const [a, b] = await Promise.all([
      vscode.workspace.openTextDocument({ content: all.slice(h.current.start, h.current.end).join('\n') + '\n', language: doc.languageId }),
      vscode.workspace.openTextDocument({ content: all.slice(h.incoming.start, h.incoming.end).join('\n') + '\n', language: doc.languageId }),
    ]);
    const r = this.contextOf(doc)?.r;
    await vscode.commands.executeCommand('vscode.diff', a.uri, b.uri, `${path.basename(uri.fsPath)}: ${r?.state.oursLabel || 'current'} ↔ ${r?.state.theirsLabel || 'incoming'}`);
  }

  /** "Explain this conflict": the commits on each side since the base that touched the hunk. */
  private async explain(uri: vscode.Uri, start: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const ctx = this.contextOf(doc);
    if (!ctx) return;
    const [ours, theirs] = await Promise.all([this.explainSide(uri, start, 'ours'), this.explainSide(uri, start, 'theirs')]);
    const now = Math.floor(Date.now() / 1000);
    type Item = vscode.QuickPickItem & { sha?: string };
    const items: Item[] = [];
    for (const [label, list] of [
      [`Current (${ctx.r.state.oursLabel}): ${ours.length} commit${ours.length === 1 ? '' : 's'}`, ours],
      [`Incoming (${ctx.r.state.theirsLabel}): ${theirs.length} commit${theirs.length === 1 ? '' : 's'}`, theirs],
    ] as const) {
      items.push({ label, kind: vscode.QuickPickItemKind.Separator });
      for (const c of list) items.push({ label: c.subject, description: `${c.author}, ${relativeTime(c.time, now)}`, detail: c.sha.slice(0, 7), sha: c.sha });
    }
    const chosen = await vscode.window.showQuickPick(items, { placeHolder: 'Why these lines conflict: what each side changed since they split. Pick a commit to open it.' });
    if (chosen?.sha) await vscode.commands.executeCommand('gitvision._openCommit', ctx.r.root, chosen.sha);
  }

  private explainSide(uri: vscode.Uri, start: number, side: 'ours' | 'theirs'): Promise<ExplainCommit[]> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    const ctx = doc && this.contextOf(doc);
    const h = doc && this.hunkAt(doc, start);
    if (!ctx || !h) return Promise.resolve([]);
    const sec = side === 'ours' ? h.current : h.incoming;
    const text = lines(doc).slice(sec.start, sec.end);
    const key = `${ctx.r.root}\0${ctx.file}\0${side}\0${text.join('\n')}`;
    let p = this.explained.get(key);
    if (!p) {
      p = this.pool.request('conflicts.explain', { root: ctx.r.root, path: ctx.file, side, lines: text }, { affinity: ctx.r.root });
      this.explained.set(key, p);
      p.catch(() => this.explained.delete(key));
    }
    return p;
  }

  // ---- file-level conflicts and the merge editor ----

  private fileCard(doc: vscode.TextDocument, r: RepoConflicts, f: ConflictFile): vscode.CodeLens[] {
    const at = new vscode.Range(0, 0, 0, 0);
    const ours = r.state.oursLabel || 'current';
    const theirs = r.state.theirsLabel || 'incoming';
    const lens = (title: string, how: 'keep' | 'delete' | 'ours' | 'theirs', file = f.path) =>
      new vscode.CodeLens(at, { title, command: 'gitvision.conflicts.resolveFile', arguments: [r.root, file, how] });
    const info = (title: string) => new vscode.CodeLens(at, { title, command: '' });
    switch (f.kind) {
      case 'deleted-by-them':
        return [info(`$(warning) Conflict: ${theirs} deleted this file; ${ours} changed it.`), lens('Keep File', 'keep'), lens('Delete File', 'delete')];
      case 'deleted-by-us':
        return [info(`$(warning) Conflict: ${ours} deleted this file; ${theirs} changed it.`), lens('Keep File', 'keep'), lens('Delete File', 'delete')];
      case 'added-by-us':
      case 'added-by-them':
        if (f.rename) {
          return [
            info(`$(warning) Conflict: ${f.rename.from} was renamed to ${f.rename.ours} (${ours}) and ${f.rename.theirs} (${theirs}).`),
            lens(`Keep ${path.basename(f.rename.ours)}`, 'keep', f.rename.ours),
            lens(`Keep ${path.basename(f.rename.theirs)}`, 'keep', f.rename.theirs),
          ];
        }
        return [info(`$(warning) Conflict: added by ${f.kind === 'added-by-us' ? ours : theirs} only.`), lens('Keep File', 'keep'), lens('Delete File', 'delete')];
      case 'binary':
        return [info('$(warning) Binary conflict.'), lens(`Keep ${ours}`, 'ours'), lens(`Keep ${theirs}`, 'theirs')];
      default:
        return [];
    }
  }

  /**
   * Resolves a file-level conflict. For a rename/rename, keeping one path deletes the other and the original.
   * Writes go through the engine's typed ops.
   */
  async resolveFile(root: string, file: string, how: 'keep' | 'delete' | 'ours' | 'theirs'): Promise<boolean> {
    const r = this.store.get(root) ?? (await this.store.refresh(root));
    const f = r?.state.files.find((x) => x.path === file);
    const ops: RepoWriteOp[] = [];
    if (how === 'ours' || how === 'theirs') ops.push({ kind: 'takeSide', path: file, side: how });
    else if (how === 'delete') ops.push({ kind: 'deleteFile', path: file });
    else if (f?.rename) {
      const other = file === f.rename.ours ? f.rename.theirs : f.rename.ours;
      ops.push({ kind: 'markResolved', path: file }, { kind: 'deleteFile', path: other }, { kind: 'deleteFile', path: f.rename.from });
    } else ops.push({ kind: 'markResolved', path: file });
    for (const op of ops) if (!(await this.write(root, op))) return false;
    await this.store.refresh(root);
    return true;
  }

  /** Hands the file to VS Code's 3-way merge editor (D4: through vscode.git's public command). */
  async openMergeEditor(uri = vscode.window.activeTextEditor?.document.uri): Promise<void> {
    if (!uri) return;
    if (this.mergeEditorAvailable()) await vscode.commands.executeCommand('git.openMergeEditor', uri);
    else await vscode.window.showTextDocument(uri);
  }

  private mergeAvailable: boolean | undefined;
  private mergeEditorAvailable(): boolean {
    if (this.mergeAvailable === undefined) {
      this.mergeAvailable = false;
      void vscode.commands.getCommands(true).then((all) => {
        this.mergeAvailable = all.includes('git.openMergeEditor');
        if (this.mergeAvailable) this._onDidChangeCodeLenses.fire();
      });
    }
    return this.mergeAvailable;
  }

  // ---- the operation: status bar, continue / skip / abort ----

  private updateStatus(): void {
    const r = this.store.all().find((x) => x.state.op);
    if (!r) return void this.status.hide();
    const { op, rebase } = r.state;
    const name = op === 'merge' ? 'Merge' : op === 'rebase' ? 'Rebase' : op === 'cherry-pick' ? 'Cherry-pick' : 'Revert';
    const step = rebase ? ` ${rebase.step}/${rebase.total}` : '';
    const left = r.hunksTotal - r.hunksResolved;
    this.status.text = `$(git-merge) ${name}${step}: ${left ? `${left} of ${r.hunksTotal} conflicts left` : 'conflicts resolved'}`;
    this.status.tooltip = `${name} of ${r.state.theirsLabel} into ${r.state.oursLabel}. Click to continue, skip or abort.`;
    this.status.command = { title: 'Continue', command: 'gitvision.conflicts.run', arguments: [r.root] };
    this.status.show();
  }

  /** Continue / Skip / Abort the stopped operation (spec: rebase mode buttons). */
  async runOperation(root?: string, choice?: 'continue' | 'skip' | 'abort'): Promise<boolean> {
    const r = (root ? this.store.get(root) : undefined) ?? this.store.all().find((x) => x.state.op);
    if (!r?.state.op) return false;
    const op = r.state.op;
    const open = r.state.files.length;
    if (!choice) {
      const items = [
        { label: '$(check) Continue', description: open ? `${open} file${open === 1 ? ' is' : 's are'} still unmerged` : 'commit the resolution and go on', choice: 'continue' as const },
        ...(op !== 'merge' ? [{ label: '$(debug-step-over) Skip', description: 'drop this commit and go on', choice: 'skip' as const }] : []),
        { label: '$(discard) Abort', description: `undo the whole ${op}`, choice: 'abort' as const },
      ];
      const p = await pick(items, `${op}${r.state.rebase ? ` ${r.state.rebase.step}/${r.state.rebase.total}` : ''}: ${r.state.theirsLabel} → ${r.state.oursLabel}`);
      if (!p) return false;
      choice = p.choice;
    }
    if (choice === 'continue' && open) {
      // Content resolved in the editor but not staged yet: offer to stage files with no markers left.
      const ready = r.files.filter((f) => !f.resolved && f.total !== null && f.remaining === 0);
      if (ready.length !== open) {
        void vscode.window.showWarningMessage(`Resolve the remaining conflicts first (${open - ready.length} file${open - ready.length === 1 ? '' : 's'}).`);
        return false;
      }
      for (const f of ready) {
        await this.saveIfDirty(r.root, f.path);
        if (!(await this.write(r.root, { kind: 'markResolved', path: f.path }))) return false;
      }
    }
    if (choice === 'abort' && !(await confirm(`Abort the ${op}?`, 'Your resolutions so far are discarded and the branch goes back to where it was.', 'Abort'))) return false;
    let ok = await this.write(r.root, { kind: choice, op }, { quiet: choice === 'continue' && op !== 'merge' });
    // A rebase or pick whose resolution leaves nothing to commit (it matches the other side) cannot continue:
    // git asks to skip that commit instead. Do that, and say so.
    if (!ok && choice === 'continue' && op !== 'merge' && /no changes|nothing to commit|nothing added to commit/i.test(this.lastWrite?.error ?? '')) {
      void vscode.window.showInformationMessage(`The resolution matches ${r.state.oursLabel}: this commit adds nothing, so it was skipped.`);
      ok = await this.write(r.root, { kind: 'skip', op });
    } else if (!ok && this.lastWrite?.error) {
      void vscode.window.showErrorMessage(`Git: ${this.lastWrite.error}`);
    }
    await this.store.refresh(r.root);
    return ok;
  }

  private async saveIfDirty(root: string, file: string): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => this.repos.fileOf(d.uri)?.path === file && this.repos.fileOf(d.uri)?.session.root === root);
    if (doc?.isDirty) await doc.save();
  }

  /** For tests: the last write and how it ended. */
  lastWrite: { op: RepoWriteOp; error?: string; code?: string } | null = null;

  private async write(root: string, op: RepoWriteOp, opts: { quiet?: boolean } = {}): Promise<boolean> {
    this.lastWrite = { op };
    try {
      await this.pool.request('repo.write', { root, op }, { affinity: root });
      return true;
    } catch (e) {
      const code = e instanceof RpcError ? e.code : undefined;
      this.lastWrite = { op, error: (e as Error).message, code };
      // A rebase that stops again on the next commit is not a failure: more conflicts to resolve.
      if (code !== 'conflict' && !opts.quiet) void vscode.window.showErrorMessage(`Git: ${(e as Error).message}`);
      return code === 'conflict';
    } finally {
      this.repos.sessionAt(root)?.poke();
    }
  }

  // ---- helpers ----

  /** The repo conflict state and repo-relative path for a document in a repo with conflicts. */
  private contextOf(doc: vscode.TextDocument): { r: RepoConflicts; file: string } | undefined {
    const f = this.repos.fileOf(doc.uri);
    const r = f && this.store.get(f.session.root);
    if (!f || !r) return undefined;
    // Markers only count in files git lists as conflicted (or resolved during this operation).
    if (!r.files.some((x) => x.path === f.path) && !r.state.files.some((x) => x.rename && [x.rename.ours, x.rename.theirs].includes(f.path))) return undefined;
    return { r, file: f.path };
  }

  private hunkAt(doc: vscode.TextDocument, start: number): ConflictHunk | undefined {
    return parseConflicts(doc.getText()).find((h) => h.start === start);
  }

  /** Offers once to turn off VS Code's own conflict CodeLens and decorations, so blocks are not drawn twice. */
  private async offerBuiltinCoexistence(): Promise<void> {
    if (this.context.globalState.get<boolean>(BUILTIN_ASKED)) return;
    const c = vscode.workspace.getConfiguration('merge-conflict');
    if (c.get<boolean>('codeLens.enabled') === false && c.get<boolean>('decorators.enabled') === false) return;
    await this.context.globalState.update(BUILTIN_ASKED, true);
    const off = 'Use GitVision Only';
    const choice = await vscode.window.showInformationMessage(
      'VS Code also draws conflict actions above each conflict, so you will see them twice. Turn off VS Code’s built-in conflict actions and colours?',
      off,
      'Keep Both',
    );
    if (choice === off) {
      await c.update('codeLens.enabled', false, vscode.ConfigurationTarget.Global);
      await c.update('decorators.enabled', false, vscode.ConfigurationTarget.Global);
    }
  }

  /** For the graph's conflict map: open a conflicted file at its first hunk. */
  async openFile(root: string, file: string): Promise<void> {
    const uri = vscode.Uri.file(path.join(root, file));
    const r = this.store.get(root);
    const f = r?.state.files.find((x) => x.path === file);
    if (f?.kind === 'binary' || (f && ['deleted-by-us', 'both-deleted'].includes(f.kind))) {
      // Nothing to show in an editor: open the side that has it, read-only.
      const api = this.gitApi();
      const side = f.kind === 'deleted-by-us' ? r!.state.theirs : r!.state.ours;
      if (api && side) await vscode.commands.executeCommand('vscode.open', gitUri(api, root, file, side));
      return;
    }
    const editor = await vscode.window.showTextDocument(uri);
    const h = parseConflicts(editor.document.getText())[0];
    if (h) {
      editor.selection = new vscode.Selection(h.start, 0, h.start, 0);
      editor.revealRange(new vscode.Range(h.start, 0, h.end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

const lines = (doc: vscode.TextDocument) => doc.getText().split(/\r\n|\n|\r/);
const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
/** The whole hunk, markers included, through the end of its closing marker line (its newline too). */
function hunkRange(doc: vscode.TextDocument, h: ConflictHunk): vscode.Range {
  const end = h.end + 1 < doc.lineCount ? new vscode.Position(h.end + 1, 0) : doc.lineAt(h.end).range.end;
  return new vscode.Range(h.start, 0, end.line, end.character);
}
/** Replacement text in the document's line ending; ends with a newline unless the hunk ended the file. */
function join(doc: vscode.TextDocument, content: string[]): string {
  if (!content.length) return '';
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  return content.join(eol) + eol;
}
