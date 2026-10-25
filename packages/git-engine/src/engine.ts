/** Registers the git engine's handlers on an RPC endpoint (runs inside a worker thread). */
import { withTransfer, type EngineEvents, type EngineMethods, type EventMap, type RpcEndpoint, type NoMethods } from '@gvx/protocol';
import { BlameService } from './blame';
import { commitGraphStatus, writeCommitGraph } from './commitGraph';
import { Git } from './git';
import { GraphLayout } from './graphLayout';
import { IndexStore } from './indexStore';
import { resolveRepo } from './repo';

/** Tables up to this size are laid out whole on the first graph page. */
const EAGER_LAYOUT_ROWS = 250_000;

export function registerEngine(rpc: RpcEndpoint<EngineMethods, NoMethods, EngineEvents, EventMap>): void {
  const trace = (msg: string) => rpc.emit('engine.trace', { msg });
  let git: Git | null = null;
  let index: IndexStore | null = null;
  let blame: BlameService | null = null;
  const ready = () => {
    if (!git || !index || !blame) throw Object.assign(new Error('engine.init has not run'), { code: 'not-initialised' });
    return { git, index, blame };
  };

  rpc.handle('engine.init', async ({ gitPath }, { signal }) => {
    git = new Git(gitPath, trace);
    index = new IndexStore(git);
    blame = new BlameService(git, trace);
    const version = await git.text(['--version'], { cwd: process.cwd(), signal });
    return { gitVersion: version.trim().replace(/^git version /, '') };
  });

  rpc.handle('repo.resolve', ({ path }, { signal }) => resolveRepo(ready().git, path, signal));

  rpc.handle('index.sync', ({ root, storageDir, full }, { signal, partial }) =>
    ready().index.sync(root, storageDir, { full, signal, onProgress: partial }),
  );

  rpc.handle('index.stats', ({ root }) => ready().index.stats(root));

  // One layout per repo, rebuilt when a sync replaces the repo's table.
  const layouts = new Map<string, GraphLayout>();
  rpc.handle('graph.page', ({ root, start, count }) => {
    const table = ready().index.table(root);
    if (!table) throw Object.assign(new Error(`No commit index for ${root}`), { code: 'no-index' });
    let layout = layouts.get(root);
    if (layout?.table !== table) {
      layouts.set(root, (layout = new GraphLayout(table)));
      // Up to 250k rows, lay out everything now (~25 ms per 100k): the graph's width is then final
      // from the first page, so text columns never shift while scrolling. Larger repos lay out lazily.
      if (table.count <= EAGER_LAYOUT_ROWS) layout.layoutTo(table.count - 1);
    }
    const p = layout.page(start, count);
    const commits = [];
    for (let r = p.start; r < p.start + p.nodeLane.length; r++) {
      const { name, email } = table.author(r);
      commits.push({ sha: table.sha(r), subject: table.subject(r), author: name, authorMail: email, time: table.time(r) });
    }
    const page = { ...p, total: table.count, commits };
    return withTransfer(page, [p.nodeLane.buffer, p.flags.buffer, p.edgeStart.buffer, p.edges.buffer] as ArrayBuffer[]);
  });

  rpc.handle('index.contains', ({ root, shas }) => ready().index.contains(root, shas));

  rpc.handle('repo.commitGraph', async ({ root }, { signal }) => {
    const info = await resolveRepo(ready().git, root, signal);
    return info ? commitGraphStatus(info.commonDir) : { graph: false, bloom: false };
  });

  rpc.handle('repo.writeCommitGraph', ({ root }, { signal }) => writeCommitGraph(ready().git, root, signal));

  rpc.handle('blame.file', async ({ root, path, rev, force, storageDir, noDiskCache }, { signal, partial }) => {
    const started = performance.now();
    const took = () => `${(performance.now() - started).toFixed(0)} ms`;
    trace(`blame ${path}: start`);
    try {
      const r = await ready().blame.blame(root, path, {
        rev,
        signal,
        force,
        storageDir,
        noDiskCache,
        onProgress: (p) => partial(withTransfer(p, [p.ranges.buffer as ArrayBuffer])),
      });
      trace(`blame ${path}: done in ${took()} (${r.source})`);
      return withTransfer(r, [r.lineCommit.buffer, r.lineOrig.buffer, r.lineFile.buffer] as ArrayBuffer[]);
    } catch (e) {
      trace(`blame ${path}: failed in ${took()}: ${(e as Error).message}`);
      throw e;
    }
  });

  rpc.handle('blame.warm', async ({ root }) => {
    await ready().blame.warm(root);
    return null;
  });

  rpc.handle('blame.remap', async ({ root, blobSha, text }, { signal }) => {
    const map = await ready().blame.remap(root, blobSha, text, signal);
    return map ? withTransfer({ map }, [map.buffer as ArrayBuffer]) : { map };
  });

  rpc.handle('blame.lineHistory', ({ root, path, line, rev, count }, { signal }) =>
    ready().blame.lineHistory(root, path, line, rev, count, signal),
  );
}
