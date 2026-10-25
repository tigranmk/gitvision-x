/**
 * Conflict state per repository (spec F4), with hunk counts per conflicted file so progress can be shown as
 * "hunks resolved / hunks total". The first count seen for a file during an operation is its total; it is
 * remembered (workspaceState) until the operation ends, so a window reload keeps the progress.
 */
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ConflictState } from '@gvx/protocol';
import type { WorkerPool } from '@gvx/git-engine';
import type { RepoRegistry } from '../repoRegistry';
import { parseConflicts } from './parser';

export interface FileProgress {
  path: string;
  /** Hunks when the conflict was first seen, and hunks still in the file. Null for non-content conflicts. */
  total: number | null;
  remaining: number | null;
  /** No longer unmerged in the index (git add / rm / checkout --ours|--theirs). */
  resolved: boolean;
}

export interface RepoConflicts {
  root: string;
  state: ConflictState;
  /** Conflicted files of this operation, including ones resolved since it stopped. */
  files: FileProgress[];
  hunksTotal: number;
  hunksResolved: number;
}

const KEY = 'gitvision.conflictTotals';

export class ConflictStore implements vscode.Disposable {
  private readonly repos = new Map<string, RepoConflicts>();
  private readonly _onDidChange = new vscode.EventEmitter<RepoConflicts>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [this._onDidChange];
  private readonly pending = new Map<string, Promise<RepoConflicts | null>>();

  constructor(
    private readonly pool: WorkerPool,
    private readonly registry: RepoRegistry,
    private readonly memento: vscode.Memento,
  ) {
    this.disposables.push(
      registry.onDidSync(({ session }) => void this.refresh(session.root)),
      registry.onDidOpen((s) => void this.refresh(s.root)),
      // Resolving hunks in the editor changes the counts before anything reaches the index.
      vscode.workspace.onDidChangeTextDocument((e) => {
        const f = registry.fileOf(e.document.uri);
        if (!f) return;
        const r = this.repos.get(f.session.root);
        if (r?.files.some((x) => x.path === f.path)) this.recount(r, f.path, e.document.getText());
      }),
    );
  }

  get(root: string): RepoConflicts | undefined {
    return this.repos.get(root);
  }

  all(): RepoConflicts[] {
    return [...this.repos.values()];
  }

  /** Re-reads the operation and its files from git (after any .git change); coalesces bursts. */
  refresh(root: string): Promise<RepoConflicts | null> {
    let p = this.pending.get(root);
    if (p) return p;
    p = this.load(root).finally(() => this.pending.delete(root));
    this.pending.set(root, p);
    return p;
  }

  private async load(root: string): Promise<RepoConflicts | null> {
    const state = await this.pool.request('conflicts.state', { root }, { affinity: root }).catch(() => null);
    if (!state) return null;
    const prev = this.repos.get(root);
    const opKey = `${root}\0${state.op}\0${state.theirs}`;
    const totals: Record<string, Record<string, number | null>> = this.memento.get(KEY, {});
    const known = { ...(totals[opKey] ?? {}) };
    if (!state.op && !state.files.length) {
      if (prev) {
        this.repos.delete(root);
        delete totals[opKey];
        void this.memento.update(KEY, pruned(totals, root));
        this._onDidChange.fire({ root, state, files: [], hunksTotal: 0, hunksResolved: 0 });
      }
      return null;
    }
    const unmerged = new Set(state.files.map((f) => f.path));
    const files: FileProgress[] = [];
    for (const f of state.files) {
      let remaining: number | null = null;
      if (f.kind === 'content') {
        const doc = vscode.workspace.textDocuments.find((d) => this.registry.fileOf(d.uri)?.path === f.path && this.registry.fileOf(d.uri)?.session.root === root);
        const text = doc ? doc.getText() : await readFile(path.join(root, f.path), 'utf8').catch(() => '');
        remaining = parseConflicts(text).length;
      }
      if (!(f.path in known)) known[f.path] = remaining;
      files.push({ path: f.path, total: known[f.path] ?? null, remaining, resolved: false });
    }
    // Files of this operation that were resolved since (no longer unmerged).
    for (const p of Object.keys(known)) {
      if (!unmerged.has(p)) files.push({ path: p, total: known[p] ?? null, remaining: known[p] === null ? null : 0, resolved: true });
    }
    totals[opKey] = known;
    void this.memento.update(KEY, totals);
    const r = summarise(root, state, files);
    this.repos.set(root, r);
    this._onDidChange.fire(r);
    return r;
  }

  private recount(r: RepoConflicts, file: string, text: string): void {
    const f = r.files.find((x) => x.path === file);
    if (!f || f.total === null) return;
    const remaining = parseConflicts(text).length;
    if (remaining === f.remaining) return;
    f.remaining = remaining;
    const next = summarise(r.root, r.state, r.files);
    this.repos.set(r.root, next);
    this._onDidChange.fire(next);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function summarise(root: string, state: ConflictState, files: FileProgress[]): RepoConflicts {
  let hunksTotal = 0;
  let hunksResolved = 0;
  for (const f of files) {
    if (f.total === null) {
      // A file-level conflict counts as one unit of work.
      hunksTotal += 1;
      if (f.resolved) hunksResolved += 1;
    } else {
      hunksTotal += f.total;
      hunksResolved += f.resolved ? f.total : Math.max(0, f.total - (f.remaining ?? 0));
    }
  }
  return { root, state, files: files.sort((a, b) => a.path.localeCompare(b.path)), hunksTotal, hunksResolved };
}

/** Drops remembered totals of this repo's finished operations. */
function pruned(totals: Record<string, unknown>, root: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(totals).filter(([k]) => !k.startsWith(`${root}\0`)));
}
