import * as path from 'node:path';
import type { RepoInfo } from '@gvx/protocol';
import type { Git } from './git';

export async function resolveRepo(git: Git, dir: string, signal?: AbortSignal): Promise<RepoInfo | null> {
  const [out, email] = await Promise.all([
    git.tryText(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--is-shallow-repository'], { cwd: dir, signal }),
    git.tryText(['config', '--get', 'user.email'], { cwd: dir, signal }),
  ]);
  if (!out) return null;
  const [root, gitDir, commonDir, shallow] = out.split('\n');
  if (!root || !gitDir || !commonDir) return null;
  return {
    root,
    gitDir,
    // --git-common-dir is relative to the cwd unless the repo is a linked worktree.
    commonDir: path.resolve(dir, commonDir).replace(/\\/g, '/'),
    isShallow: shallow === 'true',
    userEmail: email?.trim() || null,
  };
}

/** Commit SHAs of every branch, remote branch, tag (peeled) and HEAD, sorted and de-duplicated. */
export async function readTips(git: Git, root: string, signal?: AbortSignal): Promise<string[]> {
  const [refs, head] = await Promise.all([
    git.text(
      ['for-each-ref', '--format=%(objectname) %(objecttype) %(*objectname) %(*objecttype)', 'refs/heads', 'refs/remotes', 'refs/tags'],
      { cwd: root, signal },
    ),
    git.tryText(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: root, signal }),
  ]);
  const tips = new Set<string>();
  for (const line of refs.split('\n')) {
    const [obj, type, peeled, peeledType] = line.split(' ');
    if (type === 'commit' && obj) tips.add(obj);
    else if (type === 'tag' && peeledType === 'commit' && peeled) tips.add(peeled);
  }
  if (head?.trim()) tips.add(head.trim());
  return [...tips].sort();
}
