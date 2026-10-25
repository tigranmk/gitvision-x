/**
 * Time-travel (F3) in the worker: a file's revisions (following renames), its blobs (cached), and each
 * revision's changes against the previous or a pinned one, with the reader's line carried across.
 */
import type { FileRevision, RevisionRef, RevisionView } from '@gvx/protocol';
import { GitError, type Git } from './git';
import { mapLines, splitLines } from './lineDiff';
import { LruCache } from './lru';

/** Revisions above this size are shown without a diff (the editor still opens them). */
const MAX_BYTES = 2 * 1024 * 1024;

export async function fileRevisions(git: Git, root: string, path: string, signal?: AbortSignal): Promise<FileRevision[]> {
  const out = await git.text(
    ['log', '--follow', '-z', '--name-only', '--format=%x1e%H%x00%at%x00%an%x00%ae%x00%s', '--', path],
    { cwd: root, signal },
  );
  const revs: FileRevision[] = [];
  for (const rec of out.split('\x1e')) {
    const f = rec.split('\0').map((x) => x.replace(/^\n+/, ''));
    const [sha = '', time = '0', author = '', authorMail = '', subject = '', p = ''] = f;
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    revs.push({ sha, time: Number(time), author, authorMail, subject, path: p || path });
  }
  return revs;
}

interface Blob {
  bytes: Uint8Array;
  /** Decoded lines, or null for binary / oversized blobs. */
  lines: string[] | null;
  binary: boolean;
  tooLarge: boolean;
}

export class RevisionStore {
  /** (root, sha, path) → blob, at most 32 entries (each at most MAX_BYTES). */
  private readonly blobs = new LruCache<string, Promise<Blob | null>>(32, () => 1);

  constructor(private readonly git: Git) {}

  /** Bytes at `rev`, or null when the path does not exist there. */
  async blob(root: string, rev: RevisionRef, signal?: AbortSignal): Promise<Blob | null> {
    const key = `${root}\0${rev.sha}\0${rev.path}`;
    let p = this.blobs.get(key);
    if (!p) {
      p = this.load(root, rev, signal);
      this.blobs.set(key, p);
      p.catch(() => this.blobs.delete(key));
    }
    return p;
  }

  async view(
    root: string,
    rev: RevisionRef,
    against: RevisionRef | null,
    mapFrom: ({ line: number } & (RevisionRef | { text: string })) | undefined,
    signal?: AbortSignal,
  ): Promise<RevisionView> {
    const [cur, prev, from] = await Promise.all([
      this.blob(root, rev, signal),
      against ? this.blob(root, against, signal) : null,
      mapFrom && 'sha' in mapFrom ? this.blob(root, mapFrom, signal) : null,
    ]);
    if (!cur) throw Object.assign(new Error(`${rev.path} does not exist at ${rev.sha.slice(0, 7)}`), { code: 'not-found' });
    const base: RevisionView = { text: new TextDecoder().decode(cur.bytes), added: [], removed: [], mappedLine: null, binary: cur.binary, tooLarge: cur.tooLarge };
    if (!cur.lines) return base;

    if (mapFrom) {
      const fromLines = 'text' in mapFrom ? splitLines(mapFrom.text) : (from?.lines ?? null);
      base.mappedLine = fromLines ? mapLine(fromLines, cur.lines, mapFrom.line) : Math.min(mapFrom.line, Math.max(0, cur.lines.length - 1));
    }
    if (against) {
      const before = prev?.lines ?? (prev ? null : []); // missing in the comparison revision: everything is added
      if (before) Object.assign(base, changes(before, cur.lines));
    }
    return base;
  }

  private async load(root: string, rev: RevisionRef, signal?: AbortSignal): Promise<Blob | null> {
    const chunks: Buffer[] = [];
    try {
      // In a partial clone this fetches the blob on demand (the timeline shows a spinner meanwhile).
      await this.git.stream(['cat-file', 'blob', `${rev.sha}:${rev.path}`], { cwd: root, signal }, (c) => chunks.push(c));
    } catch (e) {
      if (e instanceof GitError) return null;
      throw e;
    }
    const bytes = Buffer.concat(chunks);
    const tooLarge = bytes.length > MAX_BYTES;
    const binary = !tooLarge && bytes.subarray(0, 8000).includes(0);
    return { bytes, lines: tooLarge || binary ? null : splitLines(bytes.toString('utf8')), binary, tooLarge };
  }
}

/** Lines of `after` that are new, and runs of `before` lines that are gone (placed after an unchanged line of `after`). */
export function changes(before: string[], after: string[]): Pick<RevisionView, 'added' | 'removed'> {
  const map = mapLines(before, after);
  const added: number[] = [];
  const removed: RevisionView['removed'] = [];
  // Removed runs sit after the last unchanged line, so a replaced line reads like a diff: old, then new.
  let anchor = -1;
  let nextBefore = 0;
  for (let j = 0; j <= after.length; j++) {
    const b = j < after.length ? map[j]! : before.length;
    if (b < 0) {
      added.push(j);
      continue;
    }
    if (b > nextBefore) removed.push({ after: anchor, lines: before.slice(nextBefore, b) });
    nextBefore = b + 1;
    anchor = j;
  }
  return { added, removed };
}

/**
 * Carries line `line` of `from` into `to`: the same line if it is unchanged, otherwise the nearest unchanged
 * line above it (plus the distance), so the reader stays at the same place in the code.
 */
export function mapLine(from: string[], to: string[], line: number): number {
  if (!to.length) return 0;
  const map = mapLines(to, from); // per line of `from`: its line in `to`, or -1
  for (let l = Math.min(line, from.length - 1), d = 0; l >= 0; l--, d++) {
    const t = map[l]!;
    if (t >= 0) return Math.min(to.length - 1, t + d);
  }
  return Math.min(line, to.length - 1);
}
