/**
 * Blame results persisted across sessions (D11c), so a file's slow first-ever blame happens once.
 * Keyed like the memory cache: (repo, path, blob SHA, ignore-revs hash). One small file per entry
 * under <storage>/blame/<repo hash>/; the total is pruned to a size budget, oldest first.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { BlameCommit } from '@gvx/protocol';
import type { ParsedBlame } from './blameParser';

const MAGIC = 0x31425647; // "GVB1" little-endian
const MAX_BYTES = 256 * 1024 * 1024;
const PRUNE_TO = 192 * 1024 * 1024;
const PRUNE_EVERY = 50;

const hash = (s: string, n: number) => createHash('sha1').update(s).digest('hex').slice(0, n);

interface Header {
  path: string;
  blobSha: string;
  ignore: string;
  commits: BlameCommit[];
  files: string[];
}

export class BlameDiskCache {
  private writes = 0;
  private pruning: Promise<void> | null = null;

  constructor(readonly dir: string) {}

  private file(root: string, filePath: string, blobSha: string, ignore: string): string {
    return path.join(this.dir, hash(root, 16), `${hash(`${filePath}\0${blobSha}\0${ignore}`, 32)}.gvb`);
  }

  async read(root: string, filePath: string, blobSha: string, ignore: string): Promise<ParsedBlame | null> {
    const file = this.file(root, filePath, blobSha, ignore);
    let buf: Buffer;
    try {
      buf = await readFile(file);
    } catch {
      return null;
    }
    try {
      const parsed = decode(buf, filePath, blobSha, ignore);
      // Touch, so pruning keeps recently used entries.
      const now = new Date();
      void utimes(file, now, now).catch(() => {});
      return parsed;
    } catch {
      await rm(file, { force: true }).catch(() => {});
      return null;
    }
  }

  async write(root: string, filePath: string, blobSha: string, ignore: string, b: ParsedBlame): Promise<void> {
    const file = this.file(root, filePath, blobSha, ignore);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, encode({ path: filePath, blobSha, ignore, commits: b.commits, files: b.files }, b));
    await rename(tmp, file);
    if (++this.writes % PRUNE_EVERY === 1) void this.prune();
  }

  /** Deletes least recently used entries once the cache exceeds its budget. */
  prune(maxBytes = MAX_BYTES, target = PRUNE_TO): Promise<void> {
    this.pruning ??= (async () => {
      const entries: { file: string; size: number; mtime: number }[] = [];
      for (const repo of await readdir(this.dir).catch(() => [] as string[])) {
        const dir = path.join(this.dir, repo);
        for (const name of await readdir(dir).catch(() => [] as string[])) {
          const file = path.join(dir, name);
          const s = await stat(file).catch(() => null);
          if (s?.isFile()) entries.push({ file, size: s.size, mtime: s.mtimeMs });
        }
      }
      let total = entries.reduce((n, e) => n + e.size, 0);
      if (total <= maxBytes) return;
      entries.sort((a, b) => a.mtime - b.mtime);
      for (const e of entries) {
        if (total <= target) break;
        await rm(e.file, { force: true });
        total -= e.size;
      }
    })().finally(() => {
      this.pruning = null;
    });
    return this.pruning;
  }
}

function encode(header: Header, b: ParsedBlame): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  const n = b.lineCommit.length;
  const headerLen = 12;
  const jsonPadded = (json.length + 3) & ~3;
  const out = Buffer.alloc(headerLen + jsonPadded + n * 12);
  out.writeUInt32LE(MAGIC, 0);
  out.writeUInt32LE(json.length, 4);
  out.writeUInt32LE(n, 8);
  json.copy(out, headerLen);
  let off = headerLen + jsonPadded;
  for (const col of [b.lineCommit, b.lineOrig, b.lineFile]) {
    Buffer.from(col.buffer, col.byteOffset, col.byteLength).copy(out, off);
    off += n * 4;
  }
  return out;
}

function decode(buf: Buffer, filePath: string, blobSha: string, ignore: string): ParsedBlame {
  if (buf.length < 12 || buf.readUInt32LE(0) !== MAGIC) throw new Error('not a blame cache file');
  const jsonLen = buf.readUInt32LE(4);
  const n = buf.readUInt32LE(8);
  const header = JSON.parse(buf.subarray(12, 12 + jsonLen).toString('utf8')) as Header;
  // Guards against hash collisions and format drift.
  if (header.path !== filePath || header.blobSha !== blobSha || header.ignore !== ignore) throw new Error('key mismatch');
  let off = 12 + ((jsonLen + 3) & ~3);
  if (buf.length !== off + n * 12) throw new Error('truncated');
  const col = () => {
    const a = new Uint32Array(n);
    new Uint8Array(a.buffer).set(buf.subarray(off, off + n * 4));
    off += n * 4;
    return a;
  };
  const lineCommit = col();
  const lineOrig = col();
  const lineFile = col();
  for (let i = 0; i < n; i++) {
    if (lineCommit[i]! >= header.commits.length || lineFile[i]! >= header.files.length) throw new Error('corrupt');
  }
  return { commits: header.commits, files: header.files, lineCommit, lineOrig, lineFile };
}
