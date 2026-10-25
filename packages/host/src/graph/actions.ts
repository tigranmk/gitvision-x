/**
 * Graph write actions: the commit context menu (checkout, create branch, tag, cherry-pick, revert, reset,
 * compare) and branch drag-and-drop (merge or rebase). Every write is confirmed first; git runs in the
 * engine, which accepts only these typed operations.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { RpcError, type RepoRefs, type RepoWriteOp } from '@gvx/protocol';
import type { WorkerPool } from '@gvx/git-engine';
import type { GitAPI } from '../gitApi';
import { gitUri } from '../gitUri';
import type { RepoRegistry } from '../repoRegistry';
import { confirm, input, pick } from '../ui';

/** What a commit row puts in `data-vscode-context` (and the menu passes back to the command). */
export interface CommitMenuContext {
  webviewSection: 'commit';
  root: string;
  sha: string;
  subject: string;
  /** Number of parents (merges need a mainline for cherry-pick and revert). */
  parents: number;
}

export interface BranchDrop {
  root: string;
  source: { name: string; kind: 'branch' | 'remote' };
  target: { name: string; kind: 'branch' | 'remote' };
}

const short = (sha: string) => sha.slice(0, 7);
/** Commits per "Fetch more" in a shallow clone. */
const FETCH_MORE = 100;
const quote = (s: string) => `"${s.length > 60 ? `${s.slice(0, 59)}…` : s}"`;

export class GraphActions implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** For tests: the last operation sent to the engine and how it ended. */
  lastWrite: { op: RepoWriteOp; error?: string; code?: string } | null = null;

  constructor(
    private readonly pool: WorkerPool,
    private readonly repos: RepoRegistry,
    private readonly gitApi: () => GitAPI | undefined,
  ) {
    const cmd = (id: string, fn: (c: CommitMenuContext) => Promise<unknown>) =>
      vscode.commands.registerCommand(id, (c: CommitMenuContext) => (c?.sha ? fn(c) : undefined));
    this.disposables.push(
      cmd('gitvision.graph.checkout', (c) => this.checkout(c)),
      cmd('gitvision.graph.createBranch', (c) => this.createBranch(c)),
      cmd('gitvision.graph.createTag', (c) => this.createTag(c)),
      cmd('gitvision.graph.cherryPick', (c) => this.applyCommit(c, 'cherryPick')),
      cmd('gitvision.graph.revert', (c) => this.applyCommit(c, 'revert')),
      cmd('gitvision.graph.reset', (c) => this.reset(c)),
      cmd('gitvision.graph.compareWithHead', (c) => this.compareWithHead(c)),
      cmd('gitvision.graph.copySha', async (c) => vscode.env.clipboard.writeText(c.sha)),
    );
  }

  private async checkout(c: CommitMenuContext): Promise<void> {
    const refs = await this.refs(c.root);
    const branches = refs.refs.filter((r) => r.sha === c.sha && r.kind === 'branch' && r.name !== refs.head.branch);
    const detached = { label: `Detached HEAD at ${short(c.sha)}`, description: 'Look around without moving a branch' };
    let choice: vscode.QuickPickItem | undefined = detached;
    if (branches.length) {
      choice = await pick([...branches.map((b) => ({ label: b.name, description: 'Switch to this branch' })), detached], `Check out ${short(c.sha)}`);
      if (!choice) return;
    }
    if (choice === detached) {
      const ok = await confirm(
        `Check out ${short(c.sha)} with a detached HEAD?`,
        `${quote(c.subject)}\n\nNew commits will not be on any branch until you create one.`,
        'Check Out',
      );
      if (ok) await this.write(c.root, { kind: 'checkoutDetached', sha: c.sha });
    } else {
      await this.write(c.root, { kind: 'checkout', branch: choice.label });
    }
  }

  private async createBranch(c: CommitMenuContext): Promise<void> {
    const name = await input(`Name of the new branch at ${short(c.sha)}`, { validate: nameProblem });
    if (!name) return;
    const how = await pick([{ label: 'Create and Switch' }, { label: 'Create' }], `Create branch ${name}`);
    if (how) await this.write(c.root, { kind: 'branch', name, sha: c.sha, checkout: how.label === 'Create and Switch' });
  }

  private async createTag(c: CommitMenuContext): Promise<void> {
    const name = await input(`Name of the new tag at ${short(c.sha)}`, { validate: nameProblem });
    if (!name) return;
    const message = await input(`Message for tag ${name} (leave empty for a lightweight tag)`);
    if (message === undefined) return;
    await this.write(c.root, { kind: 'tag', name, sha: c.sha, message: message || undefined });
  }

  private async applyCommit(c: CommitMenuContext, kind: 'cherryPick' | 'revert'): Promise<void> {
    const verb = kind === 'cherryPick' ? 'Cherry-pick' : 'Revert';
    let mainline: number | undefined;
    if (c.parents > 1) {
      // A merge is applied relative to one parent: the line it was merged into is almost always parent 1.
      const items = Array.from({ length: c.parents }, (_, i) => ({ label: `Parent ${i + 1}`, description: i === 0 ? 'the branch merged into (usual)' : 'a merged branch' }));
      const p = await pick(items, `${verb} merge ${short(c.sha)} relative to which parent?`);
      if (!p) return;
      mainline = items.indexOf(p) + 1;
    }
    const refs = await this.refs(c.root);
    const onto = refs.head.branch ?? `detached HEAD (${short(refs.head.sha ?? '')})`;
    const detail =
      kind === 'cherryPick'
        ? `Applies ${quote(c.subject)} as a new commit on ${onto}.`
        : `Adds a commit on ${onto} that undoes ${quote(c.subject)}.`;
    if (await confirm(`${verb} ${short(c.sha)} onto ${onto}?`, detail, verb)) {
      await this.write(c.root, { kind, sha: c.sha, mainline });
    }
  }

  private async reset(c: CommitMenuContext): Promise<void> {
    const refs = await this.refs(c.root);
    const branch = refs.head.branch ?? 'HEAD';
    const modes = [
      { label: 'Soft', mode: 'soft' as const, description: 'Keep all changes, staged' },
      { label: 'Mixed', mode: 'mixed' as const, description: 'Keep all changes, unstaged' },
      { label: 'Hard', mode: 'hard' as const, description: 'Discard all changes and uncommitted work' },
    ];
    const m = await pick(modes, `Reset ${branch} to ${short(c.sha)}`);
    if (!m) return;
    const detail =
      m.mode === 'hard'
        ? `Moves ${branch} to ${quote(c.subject)} and DISCARDS every uncommitted change in the working tree. This cannot be undone.`
        : `Moves ${branch} to ${quote(c.subject)}. Commits after it stay reachable only through the reflog. Your files are kept.`;
    if (await confirm(`${m.label} reset ${branch} to ${short(c.sha)}?`, detail, m.mode === 'hard' ? 'Discard Changes and Reset' : 'Reset')) {
      await this.write(c.root, { kind: 'reset', sha: c.sha, mode: m.mode });
    }
  }

  private async compareWithHead(c: CommitMenuContext): Promise<void> {
    const api = this.gitApi();
    if (!api) return void vscode.window.showWarningMessage('GitVision needs the built-in Git extension to compare commits.');
    const head = (await this.refs(c.root)).head.sha;
    if (!head) return;
    const files = await this.pool.request('commit.compare', { root: c.root, from: c.sha, to: head }, { affinity: c.root });
    if (!files.length) return void vscode.window.showInformationMessage(`${short(c.sha)} and HEAD have the same files.`);
    const resources = files.map((f) => [
      vscode.Uri.file(path.join(c.root, f.path)),
      f.status === 'A' ? undefined : gitUri(api, c.root, f.oldPath ?? f.path, c.sha),
      f.status === 'D' ? undefined : gitUri(api, c.root, f.path, head),
    ]);
    await vscode.commands.executeCommand('vscode.changes', `${short(c.sha)} ↔ HEAD`, resources);
  }

  /** Drag a branch onto another: merge it into that branch, or rebase it onto that branch. */
  async dropBranch(d: BranchDrop): Promise<void> {
    if (d.source.name === d.target.name) return;
    const refs = await this.refs(d.root);
    const items: (vscode.QuickPickItem & { op: 'merge' | 'rebase' })[] = [];
    if (d.target.kind === 'branch') items.push({ label: `Merge ${d.source.name} into ${d.target.name}`, op: 'merge' });
    if (d.source.kind === 'branch') items.push({ label: `Rebase ${d.source.name} onto ${d.target.name}`, op: 'rebase' });
    const choice = await pick(items, `${d.source.name} → ${d.target.name}`);
    if (!choice) return;
    if (choice.op === 'merge') {
      const switching = refs.head.branch !== d.target.name;
      const detail = `${switching ? `Switches to ${d.target.name}, then merges` : 'Merges'} ${d.source.name} into it (fast-forward when possible).`;
      if (!(await confirm(`${choice.label}?`, detail, 'Merge'))) return;
      if (switching && !(await this.write(d.root, { kind: 'checkout', branch: d.target.name }))) return;
      await this.write(d.root, { kind: 'merge', branch: d.source.name });
    } else {
      const detail = `Switches to ${d.source.name} and replays its commits on top of ${d.target.name}. The rebased commits get new ids.`;
      if (await confirm(`${choice.label}?`, detail, 'Rebase')) {
        await this.write(d.root, { kind: 'rebase', upstream: d.target.name, branch: d.source.name });
      }
    }
  }

  /** Shallow clone: fetch FETCH_MORE more commits of history. Adds history, never removes any: no confirm. */
  async fetchMore(root: string): Promise<void> {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'GitVision: fetching more history' }, () =>
      this.write(root, { kind: 'deepen', by: FETCH_MORE }),
    );
  }

  private refs(root: string): Promise<RepoRefs> {
    return this.pool.request('repo.refs', { root }, { affinity: root });
  }

  /** Sends one confirmed op; reports failures and conflicts; resyncs the graph. Resolves true on success. */
  private async write(root: string, op: RepoWriteOp): Promise<boolean> {
    this.lastWrite = { op };
    try {
      await this.pool.request('repo.write', { root, op }, { affinity: root });
      return true;
    } catch (e) {
      const code = e instanceof RpcError ? e.code : undefined;
      this.lastWrite = { op, error: (e as Error).message, code };
      if (code === 'conflict') {
        const open = 'Open Source Control';
        const what = op.kind === 'deepen' ? 'Fetch' : op.kind === 'cherryPick' ? 'Cherry-pick' : op.kind === 'revert' ? 'Revert' : op.kind === 'rebase' ? 'Rebase' : 'Merge';
        // Not awaited: the notification stays until clicked, and the command must not wait for it.
        void vscode.window.showWarningMessage(`${what} stopped with conflicts. Resolve them, then continue.`, open).then((c) => {
          if (c === open) void vscode.commands.executeCommand('workbench.view.scm');
        });
      } else {
        void vscode.window.showErrorMessage(`Git: ${(e as Error).message}`);
      }
      return false;
    } finally {
      this.repos.sessionAt(root)?.poke();
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

/** Quick client-side check; the engine validates with git check-ref-format before running anything. */
function nameProblem(v: string): string | undefined {
  if (!v.trim()) return 'Enter a name';
  if (/\s/.test(v)) return 'Names cannot contain spaces';
  if (v.startsWith('-')) return 'Names cannot start with "-"';
  return undefined;
}
