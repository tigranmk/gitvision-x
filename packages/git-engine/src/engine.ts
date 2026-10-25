/** Registers the git engine's handlers on an RPC endpoint (runs inside a worker thread). */
import { withTransfer, type GraphView, type EngineEvents, type EngineMethods, type EventMap, type RpcEndpoint, type NoMethods } from '@gvx/protocol';
import { BlameService } from './blame';
import { commitGraphStatus, writeCommitGraph } from './commitGraph';
import { Git } from './git';
import { ViewStore, searchTable } from './graphViews';
import { IndexStore } from './indexStore';
import { commitDetails, parseRawNumstat } from './commitDetails';
import { repoWrite } from './repoWrite';
import { fileMicroDiff } from './microDiff';
import { readRefs, resolveRepo } from './repo';

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

  // Layouts per (repo, view), rebuilt when a sync replaces the repo's table or HEAD moves (branch view).
  let views: ViewStore | null = null;
  const indexTable = (root: string) => {
    const table = ready().index.table(root);
    if (!table) throw Object.assign(new Error(`No commit index for ${root}`), { code: 'no-index' });
    return table;
  };
  const viewOf = (root: string, view: GraphView | undefined, signal: AbortSignal) =>
    (views ??= new ViewStore(ready().git)).get(root, indexTable(root), view, signal);

  rpc.handle('graph.page', async ({ root, view, start, count }, { signal }) => {
    const { table, layout } = await viewOf(root, view, signal);
    const p = layout.page(start, count);
    const commits = [];
    for (let r = p.start; r < p.start + p.nodeLane.length; r++) {
      const { name, email } = table.author(r);
      commits.push({ sha: table.sha(r), parents: table.parentCount(r), subject: table.subject(r), author: name, authorMail: email, time: table.time(r) });
    }
    const page = { ...p, total: table.count, commits };
    return withTransfer(page, [p.nodeLane.buffer, p.flags.buffer, p.edgeStart.buffer, p.edges.buffer] as ArrayBuffer[]);
  });

  rpc.handle('graph.search', async ({ root, view, query, limit = 10_000 }, { signal }) => {
    const { table } = await viewOf(root, view, signal);
    const path = /^path:\s*(.+)$/i.exec(query.trim())?.[1];
    if (!path) return searchTable(table, query, limit);
    // Commits touching the path, anywhere in history; glob characters switch to a glob pathspec.
    const spec = /[*?[]/.test(path) ? `:(glob,icase)${path}` : `:(icase)${path}`;
    const out = await ready().git.text(['log', '--all', '--format=%H', '--', spec], { cwd: root, signal });
    const rows = out.split('\n').filter(Boolean).map((s) => table.rowOf(s) ?? -1).filter((r) => r >= 0).sort((a, b) => a - b);
    return { rows: rows.slice(0, limit), capped: rows.length > limit };
  });

  rpc.handle('graph.rows', async ({ root, view, shas }, { signal }) => {
    const { table } = await viewOf(root, view, signal);
    return shas.map((s) => table.rowOf(s) ?? -1);
  });

  rpc.handle('commit.details', ({ root, sha }, { signal }) => commitDetails(ready().git, root, sha, signal));

  rpc.handle('commit.fileDiff', ({ root, sha, path, oldPath, maxRows }, { signal }) =>
    fileMicroDiff(ready().git, root, sha, path, oldPath, maxRows, signal),
  );

  rpc.handle('repo.write', ({ root, op }) => repoWrite(ready().git, root, op));

  rpc.handle('commit.compare', async ({ root, from, to }, { signal }) => {
    // Full ids only: anything else could be read as a diff-tree option.
    if (![from, to].every((s) => /^[0-9a-f]{40}$/.test(s))) throw Object.assign(new Error('compare needs full commit ids'), { code: 'invalid' });
    return parseRawNumstat(await ready().git.text(['diff-tree', '-r', '-z', '-M', '--raw', '--numstat', from, to], { cwd: root, signal }));
  });

  rpc.handle('repo.refs', ({ root }, { signal }) => readRefs(ready().git, root, signal));

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
