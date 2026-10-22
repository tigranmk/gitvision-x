/** Registers the git engine's handlers on an RPC endpoint (runs inside a worker thread). */
import { withTransfer, type EngineMethods, type RpcEndpoint, type NoMethods } from '@gvx/protocol';
import { BlameService } from './blame';
import { commitGraphStatus, writeCommitGraph } from './commitGraph';
import { Git } from './git';
import { IndexStore } from './indexStore';
import { resolveRepo } from './repo';

export function registerEngine(rpc: RpcEndpoint<EngineMethods, NoMethods>): void {
  let git: Git | null = null;
  let index: IndexStore | null = null;
  let blame: BlameService | null = null;
  const ready = () => {
    if (!git || !index || !blame) throw Object.assign(new Error('engine.init has not run'), { code: 'not-initialised' });
    return { git, index, blame };
  };

  rpc.handle('engine.init', async ({ gitPath }, { signal }) => {
    git = new Git(gitPath);
    index = new IndexStore(git);
    blame = new BlameService(git);
    const version = await git.text(['--version'], { cwd: process.cwd(), signal });
    return { gitVersion: version.trim().replace(/^git version /, '') };
  });

  rpc.handle('repo.resolve', ({ path }, { signal }) => resolveRepo(ready().git, path, signal));

  rpc.handle('index.sync', ({ root, storageDir, full }, { signal, partial }) =>
    ready().index.sync(root, storageDir, { full, signal, onProgress: partial }),
  );

  rpc.handle('index.stats', ({ root }) => ready().index.stats(root));

  rpc.handle('index.contains', ({ root, shas }) => ready().index.contains(root, shas));

  rpc.handle('repo.commitGraph', async ({ root }, { signal }) => {
    const info = await resolveRepo(ready().git, root, signal);
    return info ? commitGraphStatus(info.commonDir) : { graph: false, bloom: false };
  });

  rpc.handle('repo.writeCommitGraph', ({ root }, { signal }) => writeCommitGraph(ready().git, root, signal));

  rpc.handle('blame.file', async ({ root, path, rev, force, storageDir, noDiskCache }, { signal, partial }) => {
    const r = await ready().blame.blame(root, path, {
      rev,
      signal,
      force,
      storageDir,
      noDiskCache,
      onProgress: (p) => partial(withTransfer(p, [p.ranges.buffer as ArrayBuffer])),
    });
    return withTransfer(r, [r.lineCommit.buffer, r.lineOrig.buffer, r.lineFile.buffer] as ArrayBuffer[]);
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
