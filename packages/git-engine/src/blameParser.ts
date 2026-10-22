/**
 * Streaming parser for `git blame --incremental --porcelain`.
 * Entries arrive in any order: "<sha> <orig> <final> <count>", commit headers the first time a sha
 * is seen, and a closing "filename <path>" line.
 */
import type { BlameCommit } from '@gvx/protocol';

const ZERO_SHA = /^0+$/;

export interface ParsedBlame {
  commits: BlameCommit[];
  lineCommit: Uint32Array;
  lineOrig: Uint32Array;
  lineFile: Uint32Array;
  files: string[];
}

export class BlameStreamParser {
  private readonly decoder = new TextDecoder('utf-8');
  private rest = '';
  private readonly commitIndex = new Map<string, number>();
  private readonly commits: BlameCommit[] = [];
  private readonly fileIndex = new Map<string, number>();
  private readonly files: string[] = [];
  private lineCommit: number[] = [];
  private lineOrig: number[] = [];
  private lineFile: number[] = [];
  private entry: { commit: number; orig: number; final: number; count: number } | null = null;

  /** `onEntry` fires as each blame entry completes, so callers can stream partial results. */
  constructor(private readonly onEntry?: (final0: number, count: number, commit: number, orig: number, file: number) => void) {}

  get commitCount(): number {
    return this.commits.length;
  }
  get fileCount(): number {
    return this.files.length;
  }
  commitAt(i: number): BlameCommit {
    return this.commits[i]!;
  }
  fileAt(i: number): string {
    return this.files[i]!;
  }

  push(chunk: Uint8Array): void {
    const text = this.rest + this.decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
      this.line(text.slice(start, nl));
      start = nl + 1;
    }
    this.rest = text.slice(start);
  }

  end(): ParsedBlame {
    const tail = this.rest + this.decoder.decode();
    if (tail) this.line(tail);
    if (this.entry) throw new Error('git blame output ended mid-entry');
    const n = this.lineCommit.length;
    for (let i = 0; i < n; i++) {
      if (this.lineCommit[i] === undefined) throw new Error(`git blame left line ${i + 1} unattributed`);
    }
    return {
      commits: this.commits,
      lineCommit: Uint32Array.from(this.lineCommit),
      lineOrig: Uint32Array.from(this.lineOrig),
      lineFile: Uint32Array.from(this.lineFile),
      files: this.files,
    };
  }

  private line(l: string): void {
    if (!this.entry) {
      if (!l) return;
      const [sha = '', orig, final, count] = l.split(' ');
      let idx = this.commitIndex.get(sha);
      if (idx === undefined) {
        idx =
          this.commits.push({
            sha,
            author: '',
            authorMail: '',
            authorTime: 0,
            summary: '',
            boundary: false,
            uncommitted: ZERO_SHA.test(sha),
          }) - 1;
        this.commitIndex.set(sha, idx);
      }
      this.entry = { commit: idx, orig: Number(orig), final: Number(final), count: Number(count) };
      if (!(this.entry.final >= 1 && this.entry.count >= 1)) throw new Error(`Malformed blame entry: ${l}`);
      return;
    }
    const sp = l.indexOf(' ');
    const key = sp === -1 ? l : l.slice(0, sp);
    const value = sp === -1 ? '' : l.slice(sp + 1);
    const c = this.commits[this.entry.commit]!;
    switch (key) {
      case 'author':
        c.author = value;
        break;
      case 'author-mail':
        c.authorMail = value.replace(/^<|>$/g, '');
        break;
      case 'author-time':
        c.authorTime = Number(value);
        break;
      case 'summary':
        c.summary = value;
        break;
      case 'boundary':
        c.boundary = true;
        break;
      case 'previous': {
        const s = value.indexOf(' ');
        c.previous = { sha: value.slice(0, s), path: value.slice(s + 1) };
        break;
      }
      case 'filename': {
        let fi = this.fileIndex.get(value);
        if (fi === undefined) {
          fi = this.files.push(value) - 1;
          this.fileIndex.set(value, fi);
        }
        const { commit, orig, final, count } = this.entry;
        for (let i = 0; i < count; i++) {
          this.lineCommit[final - 1 + i] = commit;
          this.lineOrig[final - 1 + i] = orig + i;
          this.lineFile[final - 1 + i] = fi;
        }
        this.entry = null;
        this.onEntry?.(final - 1, count, commit, orig, fi);
        break;
      }
      // committer*, author-tz: not needed
    }
  }
}
