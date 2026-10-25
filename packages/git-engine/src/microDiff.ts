/**
 * The details pane's micro-diff: a small side-by-side view of a file's change (spec F2: up to 40 lines,
 * hunks around the changes). Lines are aligned with the same Myers diff the blame remap uses.
 */
import type { MicroDiff, MicroDiffRow } from '@gvx/protocol';
import { GitError, type Git } from './git';
import { mapLines, splitLines } from './lineDiff';

export const MICRO_DIFF_ROWS = 40;
const CONTEXT = 3;
/** Blobs above this are not diffed in the pane (the full diff editor still opens them). */
const MAX_BLOB_BYTES = 2 * 1024 * 1024;

export async function fileMicroDiff(
  git: Git,
  root: string,
  sha: string,
  path: string,
  oldPath: string | undefined,
  maxRows = MICRO_DIFF_ROWS,
  signal?: AbortSignal,
): Promise<MicroDiff> {
  const [before, after] = await Promise.all([blob(git, root, `${sha}^1:${oldPath ?? path}`, signal), blob(git, root, `${sha}:${path}`, signal)]);
  const empty = { rows: [], truncated: false, binary: false, tooLarge: false };
  if ((before && before.length > MAX_BLOB_BYTES) || (after && after.length > MAX_BLOB_BYTES)) return { ...empty, tooLarge: true };
  if (isBinary(before) || isBinary(after)) return { ...empty, binary: true };
  const dec = new TextDecoder();
  return microDiff(before ? splitLines(dec.decode(before)) : [], after ? splitLines(dec.decode(after)) : [], maxRows);
}

/** `rev:path` as bytes, or null when it does not exist (added/deleted file, root commit). */
async function blob(git: Git, root: string, spec: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  try {
    await git.stream(['cat-file', 'blob', spec], { cwd: root, signal }, (c) => chunks.push(c));
  } catch (e) {
    if (e instanceof GitError) return null;
    throw e;
  }
  return Buffer.concat(chunks);
}

/** git's heuristic: a NUL byte in the first 8,000 bytes. */
function isBinary(b: Uint8Array | null): boolean {
  if (!b) return false;
  const n = Math.min(b.length, 8000);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

/**
 * Aligns `before` and `after` side by side, then keeps the changed rows with CONTEXT unchanged rows
 * around each, up to `maxRows` rows (gaps not counted). Deleted and added lines between the same two
 * unchanged lines are paired as modified rows.
 */
export function microDiff(before: string[], after: string[], maxRows = MICRO_DIFF_ROWS): MicroDiff {
  const map = mapLines(before, after);
  const all: MicroDiffRow[] = [];
  let i = 0;
  let pendingAdd: number[] = [];
  const flush = (untilBefore: number) => {
    const dels: number[] = [];
    for (; i < untilBefore; i++) dels.push(i);
    const n = Math.max(dels.length, pendingAdd.length);
    for (let k = 0; k < n; k++) {
      const d = dels[k];
      const a = pendingAdd[k];
      const left = d !== undefined ? { line: d + 1, text: before[d]! } : undefined;
      const right = a !== undefined ? { line: a + 1, text: after[a]! } : undefined;
      all.push({ kind: left && right ? 'mod' : left ? 'del' : 'add', left, right });
    }
    pendingAdd = [];
  };
  for (let j = 0; j < after.length; j++) {
    const b = map[j]!;
    if (b < 0) {
      pendingAdd.push(j);
      continue;
    }
    flush(b);
    all.push({ kind: 'same', left: { line: b + 1, text: before[b]! }, right: { line: j + 1, text: after[j]! } });
    i = b + 1;
  }
  flush(before.length);

  // Keep changed rows plus context; collapse the rest into gaps.
  const keep = new Uint8Array(all.length);
  all.forEach((r, k) => {
    if (r.kind === 'same') return;
    for (let c = Math.max(0, k - CONTEXT); c <= Math.min(all.length - 1, k + CONTEXT); c++) keep[c] = 1;
  });
  const rows: MicroDiffRow[] = [];
  let shown = 0;
  let truncated = false;
  let last = -1;
  for (let k = 0; k < all.length; k++) {
    if (!keep[k]) continue;
    if (shown === maxRows) {
      truncated = all.slice(k).some((r) => r.kind !== 'same');
      break;
    }
    if (rows.length && k > 0 && !keep[k - 1]) rows.push({ kind: 'gap' });
    if (!rows.length && k > 0) rows.push({ kind: 'gap' });
    rows.push(all[k]!);
    shown++;
    last = k;
  }
  // Unchanged lines after the last hunk.
  if (rows.length && !truncated && last < all.length - 1) rows.push({ kind: 'gap' });
  return { rows, truncated, binary: false, tooLarge: false };
}
