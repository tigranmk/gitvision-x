import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { AUTO_BLAME_MAX_LINES, type BlameResult, type LineHistoryEntry } from '@gvx/protocol';
import { BlameStreamParser, type ParsedBlame } from './blameParser';
import type { Git } from './git';
import { mapLines, splitLines } from './lineDiff';
import { LruCache } from './lru';

const CACHE_BYTES = 64 * 1024 * 1024;
const BLOB_CACHE_BYTES = 32 * 1024 * 1024;
/** git's own heuristic: a NUL in the first 8000 bytes means binary. */
const BINARY_PROBE = 8000;

interface Blob {
  bytes: Buffer;
  lines: string[] | null; // split lazily, only when a remap needs them
}

const codeError = (message: string, code: string) => Object.assign(new Error(message), { code });

export class BlameService {
  private readonly cache = new LruCache<string, ParsedBlame & { blobSha: string | null }>(
    CACHE_BYTES,
    (b) => b.lineCommit.length * 12 + b.commits.length * 256,
  );
  private readonly blobs = new LruCache<string, Blob>(BLOB_CACHE_BYTES, (b) => b.bytes.length * 3);

  constructor(private readonly git: Git) {}

  async blame(root: string, file: string, rev = 'HEAD', signal?: AbortSignal, force = false): Promise<BlameResult> {
    const [blob, ignore] = await Promise.all([
      this.git.tryText(['rev-parse', '--verify', '-q', `${rev}:${file}`], { cwd: root, signal }),
      this.ignoreRevs(root, signal),
    ]);
    const blobSha = blob?.trim() || null;
    if (!blobSha) throw codeError(`${file} is not tracked at ${rev}`, 'not-tracked');
    if (ignore.missing) {
      // git itself refuses to blame in this state; say why instead of surfacing "fatal: could not open".
      throw codeError(`blame.ignoreRevsFile points to ${ignore.missing}, which does not exist`, 'ignore-revs-missing');
    }
    const key = `${root}\0${file}\0${blobSha}\0${ignore.hash}`;
    const hit = this.cache.get(key);
    if (hit) return { ...copy(hit), rev, blobSha, cacheHit: true };

    // Read the blob (for the binary/size checks and later remaps) while blame already runs.
    const ctl = new AbortController();
    const forward = () => ctl.abort();
    signal?.addEventListener('abort', forward, { once: true });
    const parser = new BlameStreamParser();
    const run = this.git.stream(['blame', '--incremental', '--porcelain', '-w', '-C', rev, '--', file], { cwd: root, signal: ctl.signal }, (c) =>
      parser.push(c),
    );
    run.catch(() => {}); // awaited below; this only silences the abort we may cause
    try {
      const content = await this.blob(root, blobSha, signal);
      if (content.bytes.subarray(0, BINARY_PROBE).includes(0)) throw codeError(`${file} is binary`, 'binary');
      if (!force && countLines(content.bytes) > AUTO_BLAME_MAX_LINES) {
        throw codeError(`${file} has more than ${AUTO_BLAME_MAX_LINES} lines; blame it on demand`, 'too-large');
      }
      await run;
    } catch (e) {
      ctl.abort();
      throw e;
    } finally {
      signal?.removeEventListener('abort', forward);
    }
    const parsed = parser.end();
    this.cache.set(key, { ...parsed, blobSha });
    return { ...copy(parsed), rev, blobSha, cacheHit: false };
  }

  /** Buffer line → blob line (-1 = changed). Null when the buffer equals the blob. */
  async remap(root: string, blobSha: string, text: string, signal?: AbortSignal): Promise<Int32Array | null> {
    const blob = await this.blob(root, blobSha, signal);
    blob.lines ??= splitLines(blob.bytes.toString('utf8'));
    const lines = splitLines(text);
    if (lines.length === blob.lines.length && lines.every((l, i) => l === blob.lines![i])) return null;
    return mapLines(blob.lines, lines);
  }

  async lineHistory(root: string, file: string, line: number, rev = 'HEAD', count = 10, signal?: AbortSignal): Promise<LineHistoryEntry[]> {
    const out = await this.git.text(
      ['log', `-L${line},${line}:${file}`, '-s', `-n${count}`, '--format=%x1e%H%x00%an%x00%ae%x00%at%x00%s', rev],
      { cwd: root, signal },
    );
    return out
      .split('\x1e')
      .filter((r) => r.trim())
      .map((r) => {
        const [sha = '', author = '', authorMail = '', time = '0', summary = ''] = r.replace(/\n[\s\S]*$/, '').split('\0');
        return { sha, author, authorMail, authorTime: Number(time), summary };
      });
  }

  private async blob(root: string, sha: string, signal?: AbortSignal): Promise<Blob> {
    const hit = this.blobs.get(sha);
    if (hit) return hit;
    const chunks: Buffer[] = [];
    await this.git.stream(['cat-file', 'blob', sha], { cwd: root, signal }, (c) => chunks.push(c));
    const blob: Blob = { bytes: Buffer.concat(chunks), lines: null };
    this.blobs.set(sha, blob);
    return blob;
  }

  /** Hash of the blame.ignoreRevsFile contents, so editing it invalidates cached blame. */
  private async ignoreRevs(root: string, signal?: AbortSignal): Promise<{ hash: string; missing?: string }> {
    const out = await this.git.tryText(['config', '--get-all', 'blame.ignoreRevsFile'], { cwd: root, signal });
    const files = (out ?? '').split('\n').filter(Boolean);
    if (!files.length) return { hash: '' };
    const h = createHash('sha1');
    for (const f of files) {
      try {
        h.update(await readFile(path.resolve(root, f)));
      } catch {
        return { hash: '', missing: f };
      }
    }
    return { hash: h.digest('hex') };
  }
}

function countLines(b: Buffer): number {
  let n = 0;
  for (let i = b.indexOf(10); i !== -1; i = b.indexOf(10, i + 1)) n++;
  return b.length && b[b.length - 1] !== 10 ? n + 1 : n;
}

/** Results are transferred to the host, which detaches their buffers; never hand out the cached arrays. */
function copy(b: ParsedBlame): ParsedBlame {
  return {
    commits: b.commits,
    files: b.files,
    lineCommit: b.lineCommit.slice(),
    lineOrig: b.lineOrig.slice(),
    lineFile: b.lineFile.slice(),
  };
}
