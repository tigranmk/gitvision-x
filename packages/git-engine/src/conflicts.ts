/**
 * Conflict state (spec F4): which operation stopped, its two sides and base, rebase progress, and how each
 * unmerged path conflicts (from its index stages). Read from the git dir and `git ls-files -u`.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ConflictFile, ConflictOp, ConflictState, ExplainCommit } from '@gvx/protocol';
import { GitError, type Git } from './git';
import { resolveRepo } from './repo';

const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim() : null);

export async function conflictState(git: Git, root: string, signal?: AbortSignal): Promise<ConflictState> {
  const repo = await resolveRepo(git, root, signal);
  const none: ConflictState = { op: null, ours: null, theirs: null, base: null, oursLabel: '', theirsLabel: '', rebase: null, files: [] };
  if (!repo) return none;
  const g = (f: string) => path.join(repo.gitDir, f);

  let op: ConflictOp | null = null;
  let rebase: ConflictState['rebase'] = null;
  // Which operation stopped, by the files git leaves in the git dir; theirs is the commit it was applying.
  let theirs = read(g('MERGE_HEAD'))?.split('\n')[0] ?? null;
  if (theirs) op = 'merge';
  else if (existsSync(g('rebase-merge')) || existsSync(g('rebase-apply'))) {
    op = 'rebase';
    theirs = read(g('REBASE_HEAD'));
    const dir = existsSync(g('rebase-merge')) ? 'rebase-merge' : 'rebase-apply';
    const step = Number(read(g(`${dir}/${dir === 'rebase-merge' ? 'msgnum' : 'next'}`)) ?? 0);
    const total = Number(read(g(`${dir}/${dir === 'rebase-merge' ? 'end' : 'last'}`)) ?? 0);
    if (step && total) rebase = { step, total };
  } else if ((theirs = read(g('CHERRY_PICK_HEAD')))) op = 'cherry-pick';
  else if ((theirs = read(g('REVERT_HEAD')))) op = 'revert';

  const [head, unmerged] = await Promise.all([
    git.tryText(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, signal }),
    git.text(['ls-files', '-u', '-z'], { cwd: root, signal }),
  ]);
  const files = classify(unmerged);
  // Binary content conflicts: both sides' blobs exist; git's heuristic is a NUL in the first 8,000 bytes.
  await Promise.all(
    files
      .filter((f) => f.kind === 'content')
      .map(async (f) => {
        if (await isBinary(git, root, `:2:${f.path}`, signal)) f.kind = 'binary';
      }),
  );
  if (!op) return { ...none, files };

  const ours = head?.trim() || null;
  let base: string | null = null;
  if (op === 'merge' && ours && theirs) base = (await git.tryText(['merge-base', ours, theirs], { cwd: root, signal }))?.trim() || null;
  else if (op === 'revert' && theirs) base = theirs; // reverting X applies X → X^
  else if (theirs) base = (await git.tryText(['rev-parse', '--verify', '-q', `${theirs}^`], { cwd: root, signal }))?.trim() || null;

  const nameOf = async (sha: string | null) => {
    if (!sha) return null;
    // A local branch name reads best; then remote branches.
    const byRefs = (refs: string) => git.tryText(['name-rev', '--name-only', '--no-undefined', `--refs=${refs}`, sha], { cwd: root, signal });
    const n = ((await byRefs('refs/heads/*')) ?? (await byRefs('refs/remotes/*')))?.trim();
    return n ? n.replace(/^remotes\//, '').replace(/[~^].*$/, '') : null;
  };
  const branch = (await git.tryText(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root, signal }))?.trim();
  // A rebase detaches HEAD: ours is the branch it rebases onto, theirs the branch being rebased.
  const headName = op === 'rebase' ? (read(g('rebase-merge/head-name')) ?? read(g('rebase-apply/head-name'))) : null;
  const oursLabel = branch || (await nameOf(ours)) || (ours ? ours.slice(0, 7) : 'HEAD');
  const theirsLabel = headName?.replace(/^refs\/heads\//, '') || (await nameOf(theirs)) || (theirs?.slice(0, 7) ?? '');
  return {
    op,
    ours,
    theirs,
    base,
    oursLabel,
    theirsLabel,
    rebase,
    files,
  };
}

/** `git ls-files -u -z`: "<mode> <sha> <stage>\t<path>" per stage; groups rename/rename splits. */
export function classify(out: string): ConflictFile[] {
  const stages = new Map<string, Map<number, string>>();
  for (const rec of out.split('\0')) {
    const m = /^\d+ ([0-9a-f]+) ([123])\t(.+)$/s.exec(rec);
    if (!m) continue;
    const [, sha, stage, p] = m;
    if (!stages.has(p!)) stages.set(p!, new Map());
    stages.get(p!)!.set(Number(stage), sha!);
  }
  const files: ConflictFile[] = [];
  for (const [p, s] of stages) {
    const has = (n: number) => s.has(n);
    const kind: ConflictFile['kind'] =
      has(2) && has(3)
        ? 'content'
        : has(1) && has(2)
          ? 'deleted-by-them'
          : has(1) && has(3)
            ? 'deleted-by-us'
            : has(2)
              ? 'added-by-us'
              : has(3)
                ? 'added-by-them'
                : 'both-deleted';
    files.push({ path: p, kind });
  }
  // rename/rename (1 → 2): the original path has only a base; each side added it elsewhere with the same blob.
  for (const orig of files.filter((f) => f.kind === 'both-deleted')) {
    const blob = stages.get(orig.path)!.get(1);
    const ours = files.find((f) => f.kind === 'added-by-us' && stages.get(f.path)!.get(2) === blob);
    const theirs = files.find((f) => f.kind === 'added-by-them' && stages.get(f.path)!.get(3) === blob);
    if (ours && theirs) {
      const rename = { from: orig.path, ours: ours.path, theirs: theirs.path };
      orig.rename = ours.rename = theirs.rename = rename;
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function isBinary(git: Git, root: string, spec: string, signal?: AbortSignal): Promise<boolean> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    await git.stream(['cat-file', 'blob', spec], { cwd: root, signal }, (c) => {
      if (size < 8000) chunks.push(c);
      size += c.length;
    });
  } catch (e) {
    if (e instanceof GitError) return false;
    throw e;
  }
  return Buffer.concat(chunks).subarray(0, 8000).includes(0);
}

/**
 * Commits on one side since the base that touched a hunk (spec: "Explain this conflict"). The hunk's lines
 * are found in that side's version of the file; an empty side (a deletion) falls back to the whole file.
 */
export async function explainConflict(
  git: Git,
  root: string,
  file: string,
  side: 'ours' | 'theirs',
  lines: string[],
  signal?: AbortSignal,
): Promise<ExplainCommit[]> {
  const st = await conflictState(git, root, signal);
  const rev = side === 'ours' ? st.ours : st.theirs;
  if (!rev || !st.base) return [];
  // For a revert, "theirs" is X^ applied over X; its history since the base is empty: show X itself.
  const range = st.op === 'revert' && side === 'theirs' ? [`${rev}^!`] : [`${st.base}..${rev}`];
  const blob = await git.tryText(['cat-file', 'blob', `${rev}:${file}`], { cwd: root, signal });
  const at = blob !== null && lines.length ? findBlock(blob.split(/\r?\n/), lines) : -1;
  const fmt = '--format=%x1e%H%x00%an%x00%ae%x00%at%x00%s';
  const args = at >= 0 ? ['log', '-s', fmt, `-L${at + 1},${at + lines.length}:${file}`, ...range] : ['log', fmt, ...range, '--', file];
  const out = (await git.tryText(args, { cwd: root, signal })) ?? '';
  return out
    .split('\x1e')
    .filter((r) => r.trim())
    .map((r) => {
      const [sha = '', author = '', authorMail = '', time = '0', subject = ''] = r.replace(/\n[\s\S]*$/, '').split('\0');
      return { sha, author, authorMail, time: Number(time), subject };
    });
}

/** First line where `block` occurs in `lines` (exact match), or -1. */
function findBlock(lines: string[], block: string[]): number {
  outer: for (let i = 0; i + block.length <= lines.length; i++) {
    for (let k = 0; k < block.length; k++) if (lines[i + k] !== block[k]) continue outer;
    return i;
  }
  return -1;
}
