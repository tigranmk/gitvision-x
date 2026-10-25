/**
 * Filtered graphs: the commit index restricted to the current branch or to commits touching one file.
 * A view is a LogTable of its own (rows in the index's topological order, parents rewritten to the
 * nearest commit in the view) with its own layout, rebuilt when the index or HEAD changes.
 */
import type { GraphView, RepoInfo } from '@gvx/protocol';
import type { Git } from './git';
import { GraphLayout } from './graphLayout';
import { LogTable } from './logTable';
import { readHeadSha, resolveRepo } from './repo';

export const viewKey = (v: GraphView | undefined): string => (!v || v.kind === 'all' ? 'all' : v.kind === 'branch' ? 'branch' : `file:${v.path}`);

interface Built {
  base: LogTable;
  /** HEAD the branch view was built for. */
  head: string | null;
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
    const head = view?.kind === 'branch' ? await this.head(root, signal) : null;
    let p = this.views.get(key);
    const cur = p && (await p.catch(() => null));
    if (!p || !cur || cur.base !== base || cur.head !== head) {
      p = this.build(root, base, view, head, signal);
      this.views.set(key, p);
      p.catch(() => {
        if (this.views.get(key) === p) this.views.delete(key);
      });
    }
    const built = await p;
    return { table: built.table, layout: built.layout };
  }

  private async build(root: string, base: LogTable, view: GraphView | undefined, head: string | null, signal?: AbortSignal): Promise<Built> {
    let table = base;
    if (view?.kind === 'branch') {
      // Reachability from HEAD over the index's parent links: no git process.
      const headRow = head ? base.rowOf(head) : undefined;
      const keep = headRow === undefined ? new Uint8Array(base.count) : base.reachable(headRow);
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
    const layout = new GraphLayout(table);
    if (table.count <= EAGER_LAYOUT_ROWS) layout.layoutTo(table.count - 1);
    return { base, head, table, layout };
  }

  /** HEAD from files (no git process: this runs on every page request), git only as a fallback. */
  private async head(root: string, signal?: AbortSignal): Promise<string | null> {
    let info = this.repos.get(root);
    if (!info) this.repos.set(root, (info = resolveRepo(this.git, root, signal).catch(() => null)));
    const repo = await info;
    const fromFiles = repo && (await readHeadSha(repo.gitDir, repo.commonDir));
    if (fromFiles) return fromFiles;
    return (await this.git.tryText(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: root, signal }))?.trim() || null;
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
