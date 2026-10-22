/**
 * Maps lines of an edited buffer back to lines of the blamed blob, so blame never re-runs on keystroke.
 * Common prefix/suffix are trimmed first (most edits touch a few lines), then Myers' O(ND) diff runs on
 * the middle. Past MAX_D edits the middle is treated as rewritten: those lines show as uncommitted.
 */

const MAX_D = 2000;

/** Splits text into lines the way blame counts them (a trailing newline does not add a line). */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 1 && lines[0] === '') return [];
  return lines;
}

/**
 * For each line of `after`, the 0-based line of `before` it is unchanged from, or -1 for
 * inserted/modified lines.
 */
export function mapLines(before: string[], after: string[]): Int32Array {
  const map = new Int32Array(after.length).fill(-1);
  const n = before.length;
  const m = after.length;
  let pre = 0;
  while (pre < n && pre < m && before[pre] === after[pre]) {
    map[pre] = pre;
    pre++;
  }
  let suf = 0;
  while (suf < n - pre && suf < m - pre && before[n - 1 - suf] === after[m - 1 - suf]) {
    map[m - 1 - suf] = n - 1 - suf;
    suf++;
  }
  const a = before.slice(pre, n - suf);
  const b = after.slice(pre, m - suf);
  if (!a.length || !b.length) return map;

  // Intern lines so the inner loop compares integers.
  const ids = new Map<string, number>();
  const intern = (s: string) => {
    let id = ids.get(s);
    if (id === undefined) ids.set(s, (id = ids.size));
    return id;
  };
  const A = Int32Array.from(a, intern);
  const B = Int32Array.from(b, intern);
  for (const [i, j] of myersMatches(A, B)) map[pre + j] = pre + i;
  return map;
}

/** Matching (i, j) pairs of a shortest edit script, or none when the edit distance exceeds MAX_D. */
function myersMatches(A: Int32Array, B: Int32Array): [number, number][] {
  const N = A.length;
  const M = B.length;
  const max = Math.min(N + M, MAX_D);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= N && y >= M) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return [];

  const matches: [number, number][] = [];
  let x = N;
  let y = M;
  for (let d = found; d > 0; d--) {
    const pv = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && pv[offset + k - 1]! < pv[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = pv[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) matches.push([--x, --y]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) matches.push([--x, --y]);
  return matches;
}
