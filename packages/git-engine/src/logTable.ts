/**
 * Columnar commit table in topological order (children before parents).
 * Typed-array columns keep 100k+ commits compact and serialise to one buffer
 * (the persistent index file, and later the transferable pages for the graph).
 *
 * Parent references are row numbers. A parent not (yet) in the table is negative:
 * -(k+1) indexes `externals` (shallow boundaries, or the old tail during an incremental load).
 */
import type { LogRecord } from './logParser';

const SHA_BYTES = 20;
const MAGIC = 0x31585647; // "GVX1" little-endian
const FORMAT_VERSION = 1;

function grow<T extends Uint8Array | Uint32Array | Int32Array>(arr: T, min: number): T {
  if (arr.length >= min) return arr;
  let cap = Math.max(arr.length * 2, 1024);
  while (cap < min) cap *= 2;
  const next = new (arr.constructor as new (n: number) => T)(cap);
  next.set(arr);
  return next;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function writeSha(dst: Uint8Array, offset: number, hex: string): void {
  if (hex.length !== SHA_BYTES * 2) throw new Error(`Unsupported object id length: ${hex}`);
  for (let i = 0; i < SHA_BYTES; i++) dst[offset + i] = parseInt(hex.substr(i * 2, 2), 16);
}

function readSha(src: Uint8Array, offset: number): string {
  let s = '';
  for (let i = 0; i < SHA_BYTES; i++) s += HEX[src[offset + i]!];
  return s;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class LogTable {
  count = 0;
  private shas = new Uint8Array(0);
  private parentStart = new Uint32Array(1);
  private parents = new Int32Array(0);
  private parentLen = 0;
  private authorIds = new Uint32Array(0);
  private times = new Uint32Array(0);
  private subjectStart = new Uint32Array(1);
  private subjects = new Uint8Array(0);
  private subjectLen = 0;

  /** "name\0email" strings; authorIds index this. */
  private authors: string[] = [];
  private authorIndex = new Map<string, number>();
  private externals: string[] = [];
  /** Parent sha → parent slots waiting for that commit to be appended. */
  private pending = new Map<string, number[]>();
  private rowIndex: Map<string, number> | null = null;

  /** Appends one commit. Rows must arrive in topological order. */
  append(r: LogRecord): number {
    const row = this.count;
    const n = row + 1;
    this.shas = grow(this.shas, n * SHA_BYTES);
    writeSha(this.shas, row * SHA_BYTES, r.sha);

    const waiting = this.pending.get(r.sha);
    if (waiting) {
      for (const slot of waiting) this.parents[slot] = row;
      this.pending.delete(r.sha);
    }

    this.parents = grow(this.parents, this.parentLen + r.parents.length);
    for (const p of r.parents) {
      const slot = this.parentLen++;
      const known = this.rowIndex?.get(p);
      if (known !== undefined) {
        this.parents[slot] = known;
      } else {
        this.parents[slot] = -1; // resolved by a later append, or by finalize()
        const list = this.pending.get(p);
        if (list) list.push(slot);
        else this.pending.set(p, [slot]);
      }
    }
    this.parentStart = grow(this.parentStart, n + 1);
    this.parentStart[n] = this.parentLen;

    const authorKey = `${r.author}\0${r.email}`;
    let aid = this.authorIndex.get(authorKey);
    if (aid === undefined) {
      aid = this.authors.push(authorKey) - 1;
      this.authorIndex.set(authorKey, aid);
    }
    this.authorIds = grow(this.authorIds, n);
    this.authorIds[row] = aid;
    this.times = grow(this.times, n);
    this.times[row] = r.time >>> 0;

    // UTF-8 is at most 3 bytes per UTF-16 unit.
    this.subjects = grow(this.subjects, this.subjectLen + r.subject.length * 3);
    this.subjectLen += encoder.encodeInto(r.subject, this.subjects.subarray(this.subjectLen)).written;
    this.subjectStart = grow(this.subjectStart, n + 1);
    this.subjectStart[n] = this.subjectLen;

    this.rowIndex?.set(r.sha, row);
    this.count = n;
    return row;
  }

  /** Turns parents still waiting for their commit into external references. Call after a load. */
  finalize(): this {
    for (const [sha, slots] of this.pending) {
      const ref = -(this.externals.push(sha) - 1) - 1;
      for (const slot of slots) this.parents[slot] = ref;
    }
    this.pending.clear();
    return this;
  }

  sha(row: number): string {
    this.check(row);
    return readSha(this.shas, row * SHA_BYTES);
  }

  /** Parent rows; a parent outside the table is returned as its sha string. */
  parentsOf(row: number): (number | string)[] {
    this.check(row);
    const out: (number | string)[] = [];
    for (let i = this.parentStart[row]!; i < this.parentStart[row + 1]!; i++) {
      const v = this.parents[i]!;
      out.push(v >= 0 ? v : (this.externals[-v - 1] ?? 'unresolved'));
    }
    return out;
  }

  /** Number of parents, without allocating (for hot loops such as the graph layout). */
  parentCount(row: number): number {
    return this.parentStart[row + 1]! - this.parentStart[row]!;
  }

  /** The k-th parent's row, or a negative number when that parent is outside the table. */
  parentRow(row: number, k: number): number {
    return this.parents[this.parentStart[row]! + k]!;
  }

  author(row: number): { name: string; email: string } {
    this.check(row);
    const [name = '', email = ''] = this.authors[this.authorIds[row]!]!.split('\0');
    return { name, email };
  }

  time(row: number): number {
    this.check(row);
    return this.times[row]!;
  }

  subject(row: number): string {
    this.check(row);
    return decoder.decode(this.subjects.subarray(this.subjectStart[row], this.subjectStart[row + 1]));
  }

  rowOf(sha: string): number | undefined {
    if (!this.rowIndex) {
      this.rowIndex = new Map();
      for (let r = 0; r < this.count; r++) this.rowIndex.set(readSha(this.shas, r * SHA_BYTES), r);
    }
    return this.rowIndex.get(sha);
  }

  get externalCount(): number {
    return this.externals.length;
  }

  /**
   * New commits (head) on top of an existing table (tail). Head externals that are tail
   * commits become row links; tail rows shift down by head.count.
   */
  static concat(head: LogTable, tail: LogTable): LogTable {
    if (head.pending.size || tail.pending.size) throw new Error('concat() needs finalized tables');
    const out = new LogTable();
    const n = head.count + tail.count;
    out.count = n;

    out.shas = new Uint8Array(n * SHA_BYTES);
    out.shas.set(head.shas.subarray(0, head.count * SHA_BYTES));
    out.shas.set(tail.shas.subarray(0, tail.count * SHA_BYTES), head.count * SHA_BYTES);

    out.times = new Uint32Array(n);
    out.times.set(head.times.subarray(0, head.count));
    out.times.set(tail.times.subarray(0, tail.count), head.count);

    out.authors = [...head.authors];
    out.authorIndex = new Map(head.authorIndex);
    const tailAuthor = tail.authors.map((a) => {
      let id = out.authorIndex.get(a);
      if (id === undefined) {
        id = out.authors.push(a) - 1;
        out.authorIndex.set(a, id);
      }
      return id;
    });
    out.authorIds = new Uint32Array(n);
    out.authorIds.set(head.authorIds.subarray(0, head.count));
    for (let r = 0; r < tail.count; r++) out.authorIds[head.count + r] = tailAuthor[tail.authorIds[r]!]!;

    out.subjectLen = head.subjectLen + tail.subjectLen;
    out.subjects = new Uint8Array(out.subjectLen);
    out.subjects.set(head.subjects.subarray(0, head.subjectLen));
    out.subjects.set(tail.subjects.subarray(0, tail.subjectLen), head.subjectLen);
    out.subjectStart = new Uint32Array(n + 1);
    out.subjectStart.set(head.subjectStart.subarray(0, head.count + 1));
    for (let r = 1; r <= tail.count; r++) out.subjectStart[head.count + r] = tail.subjectStart[r]! + head.subjectLen;

    const extIndex = new Map<string, number>();
    const external = (sha: string) => {
      let k = extIndex.get(sha);
      if (k === undefined) {
        k = out.externals.push(sha) - 1;
        extIndex.set(sha, k);
      }
      return -k - 1;
    };
    out.parentLen = head.parentLen + tail.parentLen;
    out.parents = new Int32Array(out.parentLen);
    for (let i = 0; i < head.parentLen; i++) {
      const v = head.parents[i]!;
      if (v >= 0) out.parents[i] = v;
      else {
        const sha = head.externals[-v - 1]!;
        const row = tail.rowOf(sha);
        out.parents[i] = row !== undefined ? row + head.count : external(sha);
      }
    }
    for (let i = 0; i < tail.parentLen; i++) {
      const v = tail.parents[i]!;
      out.parents[head.parentLen + i] = v >= 0 ? v + head.count : external(tail.externals[-v - 1]!);
    }
    out.parentStart = new Uint32Array(n + 1);
    out.parentStart.set(head.parentStart.subarray(0, head.count + 1));
    for (let r = 1; r <= tail.count; r++) out.parentStart[head.count + r] = tail.parentStart[r]! + head.parentLen;
    return out;
  }

  /**
   * A copy without the given commits (ones no tip reaches any more). Callers only drop commits
   * that no kept commit descends from, so kept parent links never point at dropped rows.
   */
  without(drop: ReadonlySet<string>): LogTable {
    if (this.pending.size) throw new Error('without() needs a finalized table');
    const out = new LogTable();
    const newRow = new Int32Array(this.count).fill(-1);
    let kept = 0;
    for (let r = 0; r < this.count; r++) if (!drop.has(this.sha(r))) newRow[r] = kept++;
    if (kept === this.count) return this;
    out.count = kept;
    out.shas = new Uint8Array(kept * SHA_BYTES);
    out.times = new Uint32Array(kept);
    out.authorIds = new Uint32Array(kept);
    out.authors = this.authors;
    out.authorIndex = this.authorIndex;
    out.externals = this.externals;
    out.parentStart = new Uint32Array(kept + 1);
    out.parents = new Int32Array(this.parentLen);
    out.subjectStart = new Uint32Array(kept + 1);
    out.subjects = new Uint8Array(this.subjectLen);
    for (let r = 0; r < this.count; r++) {
      const k = newRow[r]!;
      if (k < 0) continue;
      out.shas.set(this.shas.subarray(r * SHA_BYTES, (r + 1) * SHA_BYTES), k * SHA_BYTES);
      out.times[k] = this.times[r]!;
      out.authorIds[k] = this.authorIds[r]!;
      for (let i = this.parentStart[r]!; i < this.parentStart[r + 1]!; i++) {
        const v = this.parents[i]!;
        if (v >= 0 && newRow[v]! < 0) throw new Error(`Dropped commit ${this.sha(v)} is a parent of kept ${this.sha(r)}`);
        out.parents[out.parentLen++] = v >= 0 ? newRow[v]! : v;
      }
      out.parentStart[k + 1] = out.parentLen;
      const subj = this.subjects.subarray(this.subjectStart[r], this.subjectStart[r + 1]);
      out.subjects.set(subj, out.subjectLen);
      out.subjectLen += subj.length;
      out.subjectStart[k + 1] = out.subjectLen;
    }
    return out;
  }

  /**
   * The rows marked in `keep`, in order, copied column by column. Parents are remapped to the new rows;
   * `rewrite` replaces a row's parents (given as rows of this table) for history-simplified views. A parent
   * that is not kept becomes external (a boundary).
   */
  subset(keep: Uint8Array, rewrite?: Map<number, number[]>): LogTable {
    if (this.pending.size) throw new Error('subset() needs a finalized table');
    const newRow = new Int32Array(this.count).fill(-1);
    let kept = 0;
    for (let r = 0; r < this.count; r++) if (keep[r]) newRow[r] = kept++;
    const out = new LogTable();
    out.count = kept;
    out.shas = new Uint8Array(kept * SHA_BYTES);
    out.times = new Uint32Array(kept);
    out.authorIds = new Uint32Array(kept);
    out.authors = this.authors;
    out.authorIndex = this.authorIndex;
    out.externals = [...this.externals];
    out.parentStart = new Uint32Array(kept + 1);
    out.subjectStart = new Uint32Array(kept + 1);
    out.subjects = new Uint8Array(this.subjectLen);
    const parents: number[] = [];
    const external = new Map<number, number>(); // dropped base row → external ref
    for (let r = 0; r < this.count; r++) {
      const k = newRow[r]!;
      if (k < 0) continue;
      out.shas.set(this.shas.subarray(r * SHA_BYTES, (r + 1) * SHA_BYTES), k * SHA_BYTES);
      out.times[k] = this.times[r]!;
      out.authorIds[k] = this.authorIds[r]!;
      const ps = rewrite?.get(r);
      const n = ps ? ps.length : this.parentCount(r);
      for (let i = 0; i < n; i++) {
        const v = ps ? ps[i]! : this.parentRow(r, i);
        if (v < 0) parents.push(v); // already external in this table
        else if (newRow[v]! >= 0) parents.push(newRow[v]!);
        else {
          let ext = external.get(v);
          if (ext === undefined) external.set(v, (ext = -(out.externals.push(this.sha(v)) - 1) - 1));
          parents.push(ext);
        }
      }
      out.parentStart[k + 1] = parents.length;
      const subj = this.subjects.subarray(this.subjectStart[r], this.subjectStart[r + 1]);
      out.subjects.set(subj, out.subjectLen);
      out.subjectLen += subj.length;
      out.subjectStart[k + 1] = out.subjectLen;
    }
    out.parents = Int32Array.from(parents);
    out.parentLen = parents.length;
    return out;
  }

  /** Rows reachable from `start` (a row) through parent links, marked 1. */
  reachable(start: number): Uint8Array {
    const seen = new Uint8Array(this.count);
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const r = stack.pop()!;
      for (let i = this.parentStart[r]!; i < this.parentStart[r + 1]!; i++) {
        const p = this.parents[i]!;
        if (p >= 0 && !seen[p]) {
          seen[p] = 1;
          stack.push(p);
        }
      }
    }
    return seen;
  }

  /** One buffer: header, JSON (authors, externals, caller meta), then the columns. */
  serialize(meta: unknown = null): Uint8Array {
    if (this.pending.size) throw new Error('serialize() needs a finalized table');
    const json = encoder.encode(JSON.stringify({ authors: this.authors, externals: this.externals, meta }));
    const cols: Uint8Array[] = [
      this.shas.subarray(0, this.count * SHA_BYTES),
      bytes(this.parentStart.subarray(0, this.count + 1)),
      bytes(this.parents.subarray(0, this.parentLen)),
      bytes(this.authorIds.subarray(0, this.count)),
      bytes(this.times.subarray(0, this.count)),
      bytes(this.subjectStart.subarray(0, this.count + 1)),
      this.subjects.subarray(0, this.subjectLen),
    ];
    const header = 4 * (4 + cols.length); // magic, version, count, jsonLen, col lengths
    let size = align4(header + json.length);
    for (const c of cols) size += align4(c.length);
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, FORMAT_VERSION, true);
    view.setUint32(8, this.count, true);
    view.setUint32(12, json.length, true);
    cols.forEach((c, i) => view.setUint32(16 + i * 4, c.length, true));
    out.set(json, header);
    let off = align4(header + json.length);
    for (const c of cols) {
      out.set(c, off);
      off += align4(c.length);
    }
    return out;
  }

  static deserialize(buf: Uint8Array): { table: LogTable; meta: unknown } {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf.byteLength < 16 || view.getUint32(0, true) !== MAGIC) throw new Error('Not a GitVision index');
    if (view.getUint32(4, true) !== FORMAT_VERSION) throw new Error('Unsupported index version');
    const count = view.getUint32(8, true);
    const jsonLen = view.getUint32(12, true);
    const colLens = Array.from({ length: 7 }, (_, i) => view.getUint32(16 + i * 4, true));
    const header = 4 * (4 + colLens.length);
    const { authors, externals, meta } = JSON.parse(decoder.decode(buf.subarray(header, header + jsonLen)));
    let off = align4(header + jsonLen);
    // Copy each column so it is 4-byte aligned and independent of `buf`.
    const take = () => {
      const len = colLens.shift()!;
      const c = new Uint8Array(len); // explicit copy: Buffer#slice would alias `buf`
      c.set(buf.subarray(off, off + len));
      off += align4(len);
      return c;
    };
    const t = new LogTable();
    t.count = count;
    t.shas = take();
    t.parentStart = new Uint32Array(take().buffer);
    t.parents = new Int32Array(take().buffer);
    t.parentLen = t.parents.length;
    t.authorIds = new Uint32Array(take().buffer);
    t.times = new Uint32Array(take().buffer);
    t.subjectStart = new Uint32Array(take().buffer);
    t.subjects = take();
    t.subjectLen = t.subjects.length;
    t.authors = authors;
    t.authorIndex = new Map(authors.map((a: string, i: number) => [a, i]));
    t.externals = externals;
    if (t.parentStart.length !== count + 1 || t.times.length !== count) throw new Error('Corrupt index');
    return { table: t, meta };
  }

  private check(row: number): void {
    if (!(row >= 0 && row < this.count)) throw new RangeError(`Row ${row} out of range (0..${this.count - 1})`);
  }
}

const align4 = (n: number) => (n + 3) & ~3;
const bytes = (a: Uint32Array | Int32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
