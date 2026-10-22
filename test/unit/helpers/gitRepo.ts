import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

let clock = 1_700_000_000;

export interface TestRepo {
  dir: string;
  git(...args: string[]): string;
  write(file: string, content: string): void;
  commit(message: string, files?: Record<string, string>, author?: string): string;
  cleanup(): void;
}

export function tempDir(prefix = 'gvx-'): string {
  // realpath: macOS tmp is a symlink and git prints resolved paths.
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

export function makeRepo(dir = tempDir()): TestRepo {
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_COMMITTER_DATE: `${clock} +0000`, GIT_AUTHOR_DATE: `${clock} +0000` },
    });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  const write = (file: string, content: string) => {
    const p = path.join(dir, file);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  return {
    dir,
    git,
    write,
    commit(message, files = {}, author) {
      for (const [f, c] of Object.entries(files)) write(f, c);
      git('add', '-A');
      clock += 60;
      const args = ['commit', '-q', '--allow-empty', '-m', message];
      if (author) args.push(`--author=${author}`);
      git(...args);
      return git('rev-parse', 'HEAD').trim();
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Normalises git's forward-slash paths for comparison on Windows. */
export const fwd = (p: string) => p.replace(/\\/g, '/');
