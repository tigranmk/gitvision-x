/** Every git call is spawn (never exec) and stdout is consumed as a stream. */
import { spawn } from 'node:child_process';

export class GitError extends Error {
  readonly code = 'git';
  constructor(
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args[0] ?? ''} failed (${exitCode}): ${stderr.trim().split('\n')[0] ?? ''}`);
    this.name = 'GitError';
  }
}

export class AbortedError extends Error {
  readonly code = 'cancelled';
  constructor() {
    super('Request cancelled');
    this.name = 'AbortedError';
  }
}

export interface GitRunOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Written to stdin, then stdin is closed. */
  input?: string;
  /** Exit codes treated as success (default [0]). */
  okCodes?: number[];
}

const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  // Read-only commands must not take index.lock and race the user's own git.
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

export class Git {
  constructor(readonly path: string) {}

  /** Streams stdout chunks to `onChunk`; resolves with the exit code once git exits. */
  stream(args: string[], opts: GitRunOptions, onChunk: (chunk: Buffer) => void): Promise<number> {
    const { cwd, signal, input, okCodes = [0] } = opts;
    if (signal?.aborted) return Promise.reject(new AbortedError());
    return new Promise((resolve, reject) => {
      const child = spawn(this.path, args, { cwd, env: ENV, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => {
        child.kill();
        finish(() => reject(new AbortedError()));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (c: Buffer) => {
        if (!settled) onChunk(c);
      });
      child.stderr.setEncoding('utf8').on('data', (c: string) => {
        if (stderr.length < 16_384) stderr += c;
      });
      child.on('error', (e) => finish(() => reject(e)));
      child.on('close', (code) => {
        finish(() => (code !== null && okCodes.includes(code) ? resolve(code) : reject(new GitError(args, code, stderr))));
      });
      child.stdin.on('error', () => {}); // git may exit before reading all input
      child.stdin.end(input ?? '');
    });
  }

  /** Collects stdout as UTF-8 text. */
  async text(args: string[], opts: GitRunOptions): Promise<string> {
    const chunks: Buffer[] = [];
    await this.stream(args, opts, (c) => chunks.push(c));
    return Buffer.concat(chunks).toString('utf8');
  }

  /** Like text(), but returns null instead of throwing when git exits non-zero. */
  async tryText(args: string[], opts: GitRunOptions): Promise<string | null> {
    try {
      return await this.text(args, opts);
    } catch (e) {
      if (e instanceof GitError) return null;
      throw e;
    }
  }
}
