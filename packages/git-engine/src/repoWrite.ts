/**
 * The graph's write operations (checkout, cherry-pick, revert, reset, tag, branch, merge, rebase).
 * Only these ops exist: argv is built here from typed fields, never from a string the webview sends,
 * names are validated with `git check-ref-format`, and `--end-of-options` keeps a name from being read
 * as an option. The host confirms each op with the user before sending it.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { RepoWriteOp, RepoWriteResult } from '@gvx/protocol';
import { GitError, type Git } from './git';
import { resolveRepo } from './repo';

const SHA = /^[0-9a-f]{40}$/;
/** Files git leaves in the git dir while a merge, cherry-pick, revert or rebase waits for conflicts. */
const STOPPED_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];

class WriteError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'conflict' | 'git',
  ) {
    super(message);
  }
}

/** argv for an op, after its fields were checked. Exported for tests. */
export function writeArgs(op: RepoWriteOp): string[] {
  const sha = (s: string) => {
    if (!SHA.test(s)) throw new WriteError(`Not a full commit id: ${s}`, 'invalid');
    return s;
  };
  const mainline = (m: number | undefined) => (m === undefined ? [] : ['-m', String(Math.max(1, Math.floor(m)))]);
  switch (op.kind) {
    case 'checkout':
      return ['switch', '--end-of-options', op.branch];
    case 'checkoutDetached':
      return ['switch', '--detach', '--end-of-options', sha(op.sha)];
    case 'branch':
      return op.checkout ? ['switch', '-c', op.name, sha(op.sha)] : ['branch', '--end-of-options', op.name, sha(op.sha)];
    case 'tag':
      return op.message ? ['tag', '-a', '-m', op.message, '--end-of-options', op.name, sha(op.sha)] : ['tag', '--end-of-options', op.name, sha(op.sha)];
    case 'cherryPick':
      return ['cherry-pick', ...mainline(op.mainline), '--end-of-options', sha(op.sha)];
    case 'revert':
      return ['revert', '--no-edit', ...mainline(op.mainline), '--end-of-options', sha(op.sha)];
    case 'reset':
      if (!['soft', 'mixed', 'hard'].includes(op.mode)) throw new WriteError(`Unknown reset mode ${op.mode}`, 'invalid');
      // git reset rejects --end-of-options (seen in 2.39); a validated 40-hex id cannot be read as an option.
      return ['reset', `--${op.mode}`, sha(op.sha)];
    case 'merge':
      return ['merge', '--no-edit', '--end-of-options', op.branch];
    case 'rebase':
      return ['rebase', '--end-of-options', op.upstream, op.branch];
  }
}

/** Ref names an op creates or reads, with the check-ref-format form each must pass. */
function namesOf(op: RepoWriteOp): string[][] {
  switch (op.kind) {
    case 'checkout':
    case 'merge':
      return [['--branch', op.kind === 'checkout' ? op.branch : op.branch]];
    case 'branch':
      return [['--branch', op.name]];
    case 'tag':
      return [[`refs/tags/${op.name}`]];
    case 'rebase':
      return [['--branch', op.upstream], ['--branch', op.branch]];
    default:
      return [];
  }
}

export async function repoWrite(git: Git, root: string, op: RepoWriteOp): Promise<RepoWriteResult> {
  for (const args of namesOf(op)) {
    const name = args.at(-1)!;
    // Names that only contain a remote prefix (origin/main) are valid branch arguments too.
    if (name.startsWith('-') || (await git.tryText(['check-ref-format', ...args], { cwd: root })) === null) {
      throw new WriteError(`Not a valid name: ${name}`, 'invalid');
    }
  }
  const argv = writeArgs(op);
  const repo = await resolveRepo(git, root);
  const inProgress = () => (repo ? STOPPED_MARKERS.filter((f) => existsSync(path.join(repo.gitDir, f))) : []);
  const before = inProgress();
  try {
    // No signal: a write is never killed halfway.
    return { output: (await git.text(argv, { cwd: root })).trim() };
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    // A conflict is this op stopping halfway: a marker that was not there before it ran.
    const stopped = inProgress().some((f) => !before.includes(f));
    throw new WriteError(e.stderr.trim() || e.message, stopped ? 'conflict' : 'git');
  }
}
