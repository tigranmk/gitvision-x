/**
 * Filtered graphs: the commit index restricted to the current branch, a chosen branch, or commits touching
 * one file. A view is a LogTable of its own (rows in the index's topological order, parents rewritten to
 * the nearest commit in the view) with its own layout, rebuilt when the index or the branch tip changes.
 */
import { PENDING_SHA, type GraphView, type RepoInfo } from '@gvx/protocol';
import type { Git } from './git';
import { GraphLayout } from './graphLayout';
import { LogTable } from './logTable';
import { readRefSha, resolveRepo } from './repo';

export const viewKey = (v: GraphView | undefined): string =>
  (!v || v.kind === 'all' ? 'all' : v.kind === 'branch' ? 'branch' : v.kind === 'ref' ? `ref:${v.ref}` : `file:${v.path}`) + (v?.pending ? `+pending:${v.pending.parents.join(',')}` : '');

interface Built {
  base: LogTable;
  /** Tip the branch or ref view was built for. */
  tip: string | null;
  table: LogTable;
  layout: GraphLayout;
}

/** Tables up to this size are laid out whole on the first page (stable column width). */
const EAGER_LAYOUT_ROWS = 250_000;

export class ViewStore {
  private readonly views = new Map<string, Promise<Built>>();
  private readonly repos = new Map<string, Promise<RepoInfo | null>>();

  constructor(private readonly git: Git) {}

  /** The view's table and layout for `base` (the repo's current index), built on first use. */
  async get(root: string, base: LogTable, view: GraphView | undefined, signal?: AbortSignal): Promise<{ table: LogTable; layout: GraphLayout }> {
    const key = `${root}\0${viewKey(view)}`;
    const tip = view?.kind === 'branch' ? await this.tip(root, 'HEAD', signal) : view?.kind === 'ref' ? await this.tip(root, view.ref, signal) : null;
    let p = this.views.get(key);
    const cur = p && (await p.catch(() => null));
    if (!p || !cur || cur.base !== base || cur.tip !== tip) {
      p = this.build(root, base, view, tip, signal);
      this.views.set(key, p);
      p.catch(() => {
        if (this.views.get(key) === p) this.views.delete(key);
      });
    }
    const built = await p;
    return { table: built.table, layout: built.layout };
  }

  private async build(root: string, base: LogTable, view: GraphView | undefined, tip: string | null, signal?: AbortSignal): Promise<Built> {
    let table = base;
    if (view?.kind === 'branch' || view?.kind === 'ref') {
      // Reachability from the tip over the index's parent links: no git process.
      const tipRow = tip ? base.rowOf(tip) : undefined;
      const keep = tipRow === undefined ? new Uint8Array(base.count) : base.reachable(tipRow);
      table = keep.every((k) => k === 1) ? base : base.subset(keep);
    } else if (view?.kind === 'file') {
      // History of the file across all refs; --parents makes %P the parents rewritten by history simplification.
      const out = await this.git.text(['log', '--all', '--topo-order', '--parents', '-z', '--format=%H %P', '--', view.path], { cwd: root, signal });
      const keep = new Uint8Array(base.count);
      const rewrite = new Map<number, number[]>();
      for (const rec of out.split('\0')) {
        const [sha, ...ps] = rec.trim().split(' ');
        const row = sha ? base.rowOf(sha) : undefined;
        if (row === undefined) continue;
        keep[row] = 1;
        rewrite.set(row, ps.filter(Boolean).map((p) => base.rowOf(p) ?? -1).filter((r) => r >= 0));
      }
      table = base.subset(keep, rewrite);
    }
    if (view?.pending?.parents.length) {
      // Conflict map: a temporary node on top whose parents are the two sides (concat links them to their rows).
      const head = new LogTable();
      head.append({ sha: PENDING_SHA, parents: view.pending.parents, author: '', email: '', time: Math.floor(Date.now() / 1000), subject: '' });
      table = LogTable.concat(head.finalize(), table);
    }
    const layout = new GraphLayout(table);
    if (table.count <= EAGER_LAYOUT_ROWS) layout.layoutTo(table.count - 1);
    return { base, tip, table, layout };
  }

  /** HEAD or a branch's commit from files (no git process: this runs on every page request), git only as a fallback. */
  private async tip(root: string, ref: string, signal?: AbortSignal): Promise<string | null> {
    // Only HEAD and branch names: the ref is also a path under the git dir and an argument to git.
    if (ref !== 'HEAD' && (!/^refs\/(heads|remotes)\/[^-]/.test(ref) || ref.split('/').includes('..'))) return null;
    let info = this.repos.get(root);
    if (!info) this.repos.set(root, (info = resolveRepo(this.git, root, signal).catch(() => null)));
    const repo = await info;
    const fromFiles = repo && (await readRefSha(repo.gitDir, repo.commonDir, ref));
    if (fromFiles) return fromFiles;
    return (await this.git.tryText(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { cwd: root, signal }))?.trim() || null;
  }
}

/**
 * Rows of `table` matching `query`: a SHA prefix (4+ hex digits), or text in the subject, author name or
 * email (case-insensitive).
 */
export function searchTable(table: LogTable, query: string, limit: number): { rows: number[]; capped: boolean } {
  const q = query.trim().toLowerCase();
  const rows: number[] = [];
  if (!q) return { rows, capped: false };
  const hex = /^[0-9a-f]{4,40}$/.test(q);
  for (let r = 0; r < table.count; r++) {
    let hit = hex && table.sha(r).startsWith(q);
    if (!hit) hit = table.subject(r).toLowerCase().includes(q);
    if (!hit) {
      const { name, email } = table.author(r);
      hit = name.toLowerCase().includes(q) || email.toLowerCase().includes(q);
    }
    if (hit) {
      if (rows.length === limit) return { rows, capped: true };
      rows.push(r);
    }
  }
  return { rows, capped: false };
}
