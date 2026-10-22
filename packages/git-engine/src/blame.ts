/**
 * Blame for one file at HEAD, as fast as git allows (D10/D11):
 * - repeat requests are answered from memory or disk with no git process at all
 *   (HEAD is read from files; path → blob and the blame config are cached);
 * - a cold request starts git once: blame, the blob lookup and the blob read run concurrently;
 * - entries stream to the caller as git finds them, so recently changed lines show first.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { AUTO_BLAME_MAX_LINES, type BlameProgress, type BlameResult, type LineHistoryEntry, type RepoInfo } from '@gvx/protocol';
import { BlameDiskCache } from './blameDiskCache';
import { BlameStreamParser, type ParsedBlame } from './blameParser';
import type { Git } from './git';
import { mapLines, splitLines } from './lineDiff';
import { LruCache } from './lru';
import { readHeadSha, resolveRepo } from './repo';

const CACHE_BYTES = 64 * 1024 * 1024;
const BLOB_CACHE_BYTES = 32 * 1024 * 1024;
const PATH_BLOB_ENTRIES = 50_000;
/** git's own heuristic: a NUL in the first 8000 bytes means binary. */
const BINARY_PROBE = 8000;

interface Blob {
  bytes: Buffer;
  lines: string[] | null; // split lazily, only when a remap needs them
}

export interface BlameOptions {
  rev?: string;
  signal?: AbortSignal;
  force?: boolean;
  /** Enables the on-disk cache under <storageDir>/blame. */
  storageDir?: string;
  /** Skip the disk cache for reading (the result is still written). */
  noDiskCache?: boolean;
  onProgress?: (p: BlameProgress) => void;
}

const codeError = (message: string, code: string) => Object.assign(new Error(message), { code });

export class BlameService {
  private readonly cache = new LruCache<string, ParsedBlame>(CACHE_BYTES, (b) => b.lineCommit.length * 12 + b.commits.length * 256);
  private readonly blobs = new LruCache<string, Blob>(BLOB_CACHE_BYTES, (b) => b.bytes.length * 3);
  /** `${root}\0${commit}\0${path}` → blob SHA. */
  private readonly pathBlobs = new LruCache<string, string>(PATH_BLOB_ENTRIES, () => 1);
  private readonly repos = new Map<string, Promise<RepoInfo | null>>();
  private readonly configs = new Map<string, { fingerprint: string; files: Promise<string[]> }>();
  private readonly disks = new Map<string, BlameDiskCache>();

  constructor(private readonly git: Git) {}

  async blame(root: string, file: string, opts: BlameOptions = {}): Promise<BlameResult> {
    const { signal, force = false, storageDir, noDiskCache = false, onProgress } = opts;
    const info = await this.repo(root);
    // Pin HEAD to a commit so the cache key and the blame agree even if HEAD moves meanwhile.
    const commit = (opts.rev ?? 'HEAD') === 'HEAD' && info ? await readHeadSha(info.gitDir, info.commonDir) : null;
    const rev = commit ?? opts.rev ?? 'HEAD';
    const ignore = await this.ignoreRevs(root, info, signal);
    if (ignore.missing) {
      // git itself refuses to blame in this state; say why instead of surfacing "fatal: could not open".
      throw codeError(`blame.ignoreRevsFile points to ${ignore.missing}, which does not exist`, 'ignore-revs-missing');
    }
    const disk = storageDir ? this.disk(storageDir) : null;
    const pathKey = commit ? `${root}\0${commit}\0${file}` : null;
    const memKey = (blob: string) => `${root}\0${file}\0${blob}\0${ignore.hash}`;
    const result = (b: ParsedBlame, blobSha: string, source: BlameResult['source']): BlameResult => ({
      ...copy(b),
      rev,
      blobSha,
      source,
      cacheHit: source !== 'git',
    });
    const fromCaches = async (blobSha: string): Promise<BlameResult | null> => {
      const hit = this.cache.get(memKey(blobSha));
      if (hit) return result(hit, blobSha, 'memory');
      const stored = disk && !noDiskCache ? await disk.read(root, file, blobSha, ignore.hash) : null;
      if (!stored) return null;
      this.cache.set(memKey(blobSha), stored);
      return result(stored, blobSha, 'disk');
    };

    const known = pathKey ? this.pathBlobs.get(pathKey) : undefined;
    if (known) {
      const cached = await fromCaches(known);
      if (cached) return cached;
    }

    // Cold: start blame now; resolve the blob concurrently and abort blame if it turns out cached/unsuitable.
    const ctl = new AbortController();
    const forward = () => ctl.abort();
    signal?.addEventListener('abort', forward, { once: true });
    const stream = new ProgressStream(onProgress);
    const parser = new BlameStreamParser((final0, count, commitIdx, orig, fileIdx) => stream.range(final0, count, commitIdx, orig, fileIdx));
    const run = this.git.stream(['blame', '--incremental', '--porcelain', '-w', '-C', rev, '--', file], { cwd: root, signal: ctl.signal }, (c) => {
      parser.push(c);
      stream.flush(parser);
    });
    run.catch(() => {}); // awaited below; this only silences the abort we may cause
    try {
      let blobSha = known ?? null;
      if (!blobSha) {
        blobSha = (await this.git.tryText(['rev-parse', '--verify', '-q', `${rev}:${file}`], { cwd: root, signal }))?.trim() || null;
        if (!blobSha) throw codeError(`${file} is not tracked at ${opts.rev ?? 'HEAD'}`, 'not-tracked');
        if (pathKey) this.pathBlobs.set(pathKey, blobSha);
        const cached = await fromCaches(blobSha);
        if (cached) {
          ctl.abort();
          return cached;
        }
      }
      const content = await this.blob(root, blobSha, signal);
      if (content.bytes.subarray(0, BINARY_PROBE).includes(0)) throw codeError(`${file} is binary`, 'binary');
      if (!force && countLines(content.bytes) > AUTO_BLAME_MAX_LINES) {
        throw codeError(`${file} has more than ${AUTO_BLAME_MAX_LINES} lines; blame it on demand`, 'too-large');
      }
      stream.open(blobSha, parser); // entries buffered until the checks passed are sent now
      await run;
      const parsed = parser.end();
      stream.flush(parser);
      this.cache.set(memKey(blobSha), parsed);
      if (disk) void disk.write(root, file, blobSha, ignore.hash, parsed).catch(() => {});
      return result(parsed, blobSha, 'git');
    } catch (e) {
      ctl.abort();
      throw e;
    } finally {
      signal?.removeEventListener('abort', forward);
    }
  }

  async warm(root: string): Promise<void> {
    const info = await this.repo(root);
    await this.ignoreRevs(root, info);
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

  private repo(root: string): Promise<RepoInfo | null> {
    let p = this.repos.get(root);
    if (!p) {
      p = resolveRepo(this.git, root).catch(() => null);
      this.repos.set(root, p);
    }
    return p;
  }

  private disk(storageDir: string): BlameDiskCache {
    let d = this.disks.get(storageDir);
    if (!d) this.disks.set(storageDir, (d = new BlameDiskCache(path.join(storageDir, 'blame'))));
    return d;
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

  /**
   * Hash of the blame.ignoreRevsFile contents (part of every cache key). `git config` runs only when
   * a config file's mtime changed; the ignore files themselves are re-read (cheap) every time.
   * Not tracked: config pulled in through [include] directives and the system config.
   */
  private async ignoreRevs(root: string, info: RepoInfo | null, signal?: AbortSignal): Promise<{ hash: string; missing?: string }> {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
    const sources = [
      process.env.GIT_CONFIG_GLOBAL || path.join(homedir(), '.gitconfig'),
      path.join(xdg, 'git', 'config'),
      ...(info ? [path.join(info.commonDir, 'config'), path.join(info.gitDir, 'config.worktree')] : []),
    ];
    const fingerprint = (await Promise.all(sources.map((f) => stat(f).then((s) => `${s.mtimeMs}:${s.size}`, () => '-')))).join('|');
    let cached = this.configs.get(root);
    if (!info || !cached || cached.fingerprint !== fingerprint) {
      const files = this.git
        .tryText(['config', '--get-all', 'blame.ignoreRevsFile'], { cwd: root, signal })
        .then((out) => (out ?? '').split('\n').filter(Boolean));
      cached = { fingerprint, files };
      if (info) this.configs.set(root, cached);
      files.catch(() => this.configs.delete(root));
    }
    const files = await cached.files;
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

/**
 * Batches blame entries into BlameProgress messages: one per stdout chunk. Entries are held back
 * until open() (the binary/size checks passed), so a binary file never streams garbage.
 */
class ProgressStream {
  private ranges: number[] = [];
  /** Highest commit index a completed entry referenced; later commits may still be mid-header. */
  private maxCommit = -1;
  private sentCommits = 0;
  private sentFiles = 0;
  private blobSha: string | null = null;
  private opened = false;

  constructor(private readonly emit?: (p: BlameProgress) => void) {}

  range(final0: number, count: number, commit: number, orig: number, file: number): void {
    if (!this.emit) return;
    this.ranges.push(final0, count, commit, orig, file);
    if (commit > this.maxCommit) this.maxCommit = commit;
  }

  open(blobSha: string, parser: BlameStreamParser): void {
    this.blobSha = blobSha;
    this.opened = true;
    this.flush(parser);
  }

  flush(parser: BlameStreamParser): void {
    if (!this.emit || !this.opened || !this.ranges.length) return;
    const commits: BlameProgress['commits'] = [];
    for (let i = this.sentCommits; i <= this.maxCommit; i++) commits.push({ ...parser.commitAt(i) });
    const files: string[] = [];
    for (let i = this.sentFiles; i < parser.fileCount; i++) files.push(parser.fileAt(i));
    this.sentCommits = Math.max(this.sentCommits, this.maxCommit + 1);
    this.sentFiles = parser.fileCount;
    const ranges = Uint32Array.from(this.ranges);
    this.ranges = [];
    this.emit({ blobSha: this.blobSha, commits, files, ranges });
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
