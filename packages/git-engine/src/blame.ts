import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { BlameResult } from '@gvx/protocol';
import { BlameStreamParser, type ParsedBlame } from './blameParser';
import type { Git } from './git';
import { LruCache } from './lru';

const CACHE_BYTES = 64 * 1024 * 1024;

export class BlameService {
  private readonly cache = new LruCache<string, ParsedBlame & { blobSha: string | null }>(
    CACHE_BYTES,
    (b) => b.lineCommit.length * 12 + b.commits.length * 256,
  );

  constructor(private readonly git: Git) {}

  async blame(root: string, file: string, rev = 'HEAD', signal?: AbortSignal): Promise<BlameResult> {
    const [blob, ignore] = await Promise.all([
      this.git.tryText(['rev-parse', '--verify', '-q', `${rev}:${file}`], { cwd: root, signal }),
      this.ignoreRevs(root, signal),
    ]);
    const blobSha = blob?.trim() || null;
    if (!blobSha) throw Object.assign(new Error(`${file} is not tracked at ${rev}`), { code: 'not-tracked' });

    if (ignore.missing) {
      // git itself refuses to blame in this state; say why instead of surfacing "fatal: could not open".
      throw Object.assign(new Error(`blame.ignoreRevsFile points to ${ignore.missing}, which does not exist`), {
        code: 'ignore-revs-missing',
      });
    }
    const key = `${root}\0${file}\0${blobSha}\0${ignore.hash}`;
    const hit = this.cache.get(key);
    if (hit) return { ...copy(hit), rev, blobSha, cacheHit: true };

    const args = ['blame', '--incremental', '--porcelain', '-w', '-C', rev, '--', file];
    const parser = new BlameStreamParser();
    await this.git.stream(args, { cwd: root, signal }, (c) => parser.push(c));
    const parsed = parser.end();
    this.cache.set(key, { ...parsed, blobSha });
    return { ...copy(parsed), rev, blobSha, cacheHit: false };
  }

  /** Hash of the blame.ignoreRevsFile contents, so editing it invalidates cached blame. */
  private async ignoreRevs(root: string, signal?: AbortSignal): Promise<{ hash: string; missing?: string }> {
    const out = await this.git.tryText(['config', '--get-all', 'blame.ignoreRevsFile'], { cwd: root, signal });
    const files = (out ?? '').split('\n').filter(Boolean);
    if (!files.length) return { hash: '' };
    const h = createHash('sha1');
    for (const f of files) {
      const p = path.resolve(root, f);
      try {
        h.update(await readFile(p));
      } catch {
        return { hash: '', missing: f };
      }
    }
    return { hash: h.digest('hex') };
  }
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
