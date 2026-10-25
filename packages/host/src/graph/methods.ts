/**
 * What the host serves the graph webview. No vscode import: the Playwright harness registers the same
 * handlers, so webview tests run against the real host logic.
 */
import { RpcError, type EventMap, type GraphHostEvents, type GraphHostMethods, type GraphState, type NoMethods, type RpcEndpoint } from '@gvx/protocol';
import type { WorkerPool } from '@gvx/git-engine';

export type GraphRpc = RpcEndpoint<GraphHostMethods, NoMethods, GraphHostEvents, EventMap>;

export interface GraphMethodDeps {
  pool: Pick<WorkerPool, 'request'>;
  state(): GraphState;
  /** Repo shown now; requests for any other repo are stale. */
  shown(): string | null;
  /** Repo-relative paths open in editor tabs. */
  openFiles(root: string): string[];
  writeClipboard(text: string): PromiseLike<void>;
  openDiff(args: GraphHostMethods['graph.openDiff']['params']): PromiseLike<void>;
  dropBranch(args: GraphHostMethods['graph.dropBranch']['params']): PromiseLike<void>;
}

export function registerGraphMethods(rpc: GraphRpc, d: GraphMethodDeps): void {
  const current = (root: string) => {
    if (root !== d.shown()) throw new RpcError(`Graph moved on from ${root}`, 'stale');
    return root;
  };
  rpc.handle('graph.state', () => d.state());
  rpc.handle('graph.page', ({ root, view, start, count }, { signal }) =>
    d.pool.request('graph.page', { root: current(root), view, start, count }, { affinity: root, signal }),
  );
  rpc.handle('graph.rows', ({ root, view, shas }, { signal }) =>
    d.pool.request('graph.rows', { root: current(root), view, shas }, { affinity: root, signal }),
  );
  rpc.handle('graph.search', ({ root, view, query }, { signal }) =>
    d.pool.request('graph.search', { root: current(root), view, query }, { affinity: root, signal }),
  );
  rpc.handle('graph.refs', async ({ root, view }, { signal }) => {
    const { head, refs } = await d.pool.request('repo.refs', { root: current(root) }, { affinity: root, signal });
    const shas = [...new Set([...refs.map((r) => r.sha), ...(head.sha ? [head.sha] : [])])];
    const rows = await d.pool.request('graph.rows', { root, view, shas }, { affinity: root, signal });
    const rowOf = new Map(shas.map((sha, i) => [sha, rows[i] ?? -1]));
    return {
      head: { ...head, row: head.sha ? (rowOf.get(head.sha) ?? -1) : -1 },
      refs: refs.map((r) => ({ ...r, row: rowOf.get(r.sha) ?? -1 })),
    };
  });
  rpc.handle('graph.details', async ({ root, sha }, { signal }) => {
    const details = await d.pool.request('commit.details', { root: current(root), sha }, { affinity: root, signal });
    const open = new Set(d.openFiles(root));
    return { ...details, files: details.files.map((f) => ({ ...f, open: open.has(f.path) })) };
  });
  rpc.handle('graph.fileDiff', ({ root, sha, path, oldPath }, { signal }) =>
    d.pool.request('commit.fileDiff', { root: current(root), sha, path, oldPath }, { affinity: root, signal }),
  );
  rpc.handle('graph.openDiff', async (args) => {
    current(args.root);
    await d.openDiff(args);
    return null;
  });
  rpc.handle('graph.dropBranch', async (args) => {
    current(args.root);
    await d.dropBranch(args);
    return null;
  });
  rpc.handle('clipboard.write', async ({ text }) => {
    await d.writeClipboard(text);
    return null;
  });
}
