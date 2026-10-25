/** One commit's message and changed files (+/− per file), for the graph's details pane. */
import type { CommitDetails, CommitFile } from '@gvx/protocol';
import type { Git } from './git';

/** Files listed per commit; the rest are counted in `filesTruncated`. */
export const MAX_FILES = 2000;

export async function commitDetails(git: Git, root: string, sha: string, signal?: AbortSignal): Promise<CommitDetails> {
  const meta = await git.text(['log', '-1', '-z', '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B', sha, '--'], { cwd: root, signal });
  // -z ends the record with NUL; %B cannot contain one, so the message is the ninth field.
  const [full = '', parents = '', author = '', authorMail = '', at = '0', committer = '', committerMail = '', ct = '0', body = ''] = meta.split('\0');
  const parentList = parents ? parents.split(' ') : [];
  // Against the first parent, like `git show --first-parent`; the root commit shows everything as added.
  const range = parentList.length ? [parentList[0]!, full] : ['--root', full];
  const out = await git.text(['diff-tree', '-r', '-z', '-M', '--raw', '--numstat', '--no-commit-id', ...range], { cwd: root, signal });
  const files = parseRawNumstat(out);
  return {
    sha: full,
    parents: parentList,
    author,
    authorMail,
    authorTime: Number(at),
    committer,
    committerMail,
    commitTime: Number(ct),
    message: body.replace(/\s+$/, ''),
    files: files.slice(0, MAX_FILES),
    filesTruncated: Math.max(0, files.length - MAX_FILES),
  };
}

/**
 * Parses `diff-tree -z --raw --numstat`: all raw records (`:modes shas STATUS\0path\0[path\0]`) come
 * first, then one numstat record per file in the same order (`added\tremoved\tpath\0`, or for renames
 * `added\tremoved\t\0old\0new\0`; binary files show `-\t-`).
 */
export function parseRawNumstat(out: string): CommitFile[] {
  const t = out.split('\0');
  const files: CommitFile[] = [];
  let i = 0;
  while (i < t.length && t[i]!.startsWith(':')) {
    const status = t[i]!.split(' ')[4] ?? '';
    const letter = status[0] ?? 'M';
    if (letter === 'R' || letter === 'C') {
      files.push({ status: letter, oldPath: t[i + 1]!, path: t[i + 2]!, added: 0, removed: 0, binary: false });
      i += 3;
    } else {
      files.push({ status: letter, path: t[i + 1]!, added: 0, removed: 0, binary: false });
      i += 2;
    }
  }
  for (const f of files) {
    const rec = t[i] ?? '';
    const [a = '0', r = '0', p = ''] = rec.split('\t');
    i += p === '' ? 3 : 1; // a rename's paths follow as two more tokens
    f.binary = a === '-';
    f.added = f.binary ? 0 : Number(a);
    f.removed = f.binary ? 0 : Number(r);
  }
  return files;
}
