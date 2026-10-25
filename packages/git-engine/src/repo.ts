import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { RefInfo, RepoInfo, RepoRefs } from '@gvx/protocol';
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

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Resolves HEAD to a commit SHA by reading files (no git process): HEAD in the worktree git dir,
 * then the loose ref or packed-refs in the common dir. Returns null when that is not possible
 * (reftable, unborn branch, unusual layouts); callers then fall back to `git rev-parse`.
 */
export async function readHeadSha(gitDir: string, commonDir: string): Promise<string | null> {
  let ref = 'HEAD';
  for (let depth = 0; depth < 5; depth++) {
    const dir = perWorktree(ref) ? gitDir : commonDir;
    let content = await readFile(path.join(dir, ref), 'utf8').catch(() => null);
    if (content === null && dir !== commonDir) content = await readFile(path.join(commonDir, ref), 'utf8').catch(() => null);
    if (content === null) return packedRef(commonDir, ref);
    content = content.trim();
    if (SHA_RE.test(content)) return content;
    if (!content.startsWith('ref: ')) return null;
    ref = content.slice(5).trim();
  }
  return null;
}

/** HEAD and pseudo-refs live in the worktree's git dir; branches, remotes and tags are shared. */
const perWorktree = (ref: string) => !['refs/heads/', 'refs/remotes/', 'refs/tags/'].some((p) => ref.startsWith(p));

async function packedRef(commonDir: string, ref: string): Promise<string | null> {
  const packed = await readFile(path.join(commonDir, 'packed-refs'), 'utf8').catch(() => null);
  if (!packed) return null;
  for (const line of packed.split('\n')) {
    if (line.endsWith(` ${ref}`)) {
      const sha = line.slice(0, 40);
      return SHA_RE.test(sha) ? sha : null;
    }
  }
  return null;
}

/** Branch, remote and tag names (tags peeled to their commit) and HEAD, for graph labels and the details pane. */
export async function readRefs(git: Git, root: string, signal?: AbortSignal): Promise<RepoRefs> {
  const [list, head, branch] = await Promise.all([
    git.text(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(symref)', 'refs/heads', 'refs/remotes', 'refs/tags'], { cwd: root, signal }),
    git.tryText(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: root, signal }),
    git.tryText(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root, signal }),
  ]);
  const refs: RefInfo[] = [];
  for (const line of list.split('\n')) {
    const [ref = '', obj = '', peeled = '', symref = ''] = line.split('\0');
    if (!ref || symref) continue; // origin/HEAD and other symbolic refs repeat a real ref
    const sha = peeled || obj;
    if (ref.startsWith('refs/heads/')) refs.push({ name: ref.slice(11), kind: 'branch', sha });
    else if (ref.startsWith('refs/remotes/')) refs.push({ name: ref.slice(13), kind: 'remote', sha });
    else if (ref.startsWith('refs/tags/')) refs.push({ name: ref.slice(10), kind: 'tag', sha });
  }
  return { head: { sha: head?.trim() || null, branch: branch?.trim() || null }, refs };
}
