import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface TestState {
  activationMs: number;
  workersStarted: number;
  repos: { info: { root: string; gitDir: string; commonDir: string }; stats: { commitCount: number; mode: string } | null }[];
  selection: { repo: string | null; file: string | null; line: number | null };
  refsEvents: { root: string; mode: string }[];
}

const workspace = process.env.GVX_WORKSPACE!;
const realRoot = process.env.GVX_WORKSPACE_REAL!.replace(/\\/g, '/');
const state = () => vscode.commands.executeCommand<TestState>('gitvision._test.state');

async function waitFor<T>(what: string, probe: () => Promise<T | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'IT', GIT_AUTHOR_EMAIL: 'it@x', GIT_COMMITTER_NAME: 'IT', GIT_COMMITTER_EMAIL: 'it@x' },
  });

export function defineSuite(): void {
  describe('GitVision X — M0 foundation', () => {
    before(async () => {
      const ext = vscode.extensions.getExtension('gitvision-x.gitvision-x');
      assert.ok(ext, 'extension is installed');
      await ext.activate();
    });

    it('activates within the 30 ms budget', async () => {
      const s = await state();
      assert.ok(s.activationMs < 30, `activate() took ${s.activationMs.toFixed(1)} ms`);
    });

    it('indexes the workspace repository', async () => {
      const repo = await waitFor('initial index', async () => (await state()).repos.find((r) => r.stats));
      assert.equal(repo.info.root, realRoot);
      assert.equal(repo.stats!.commitCount, 5);
      assert.ok((await state()).workersStarted >= 1);
    });

    it('picks up a new commit through the .git watcher, incrementally', async () => {
      writeFileSync(path.join(workspace, 'new.txt'), 'hello\n');
      git('add', 'new.txt');
      git('commit', '-q', '-m', 'from the test');
      const repo = await waitFor('incremental sync', async () => (await state()).repos.find((r) => r.stats?.commitCount === 6));
      assert.equal(repo.stats!.mode, 'incremental');
      assert.ok((await state()).refsEvents.some((e) => e.mode === 'incremental'));
    });

    it('drops commits when a branch is deleted', async () => {
      git('branch', 'doomed', 'HEAD');
      git('checkout', '-q', 'doomed');
      git('commit', '-q', '--allow-empty', '-m', 'only on doomed');
      git('checkout', '-q', 'main');
      await waitFor('doomed branch indexed', async () => (await state()).repos.find((r) => r.stats?.commitCount === 7));
      git('branch', '-D', 'doomed');
      const repo = await waitFor('branch removal', async () => (await state()).repos.find((r) => r.stats?.commitCount === 6));
      assert.equal(repo.stats!.mode, 'incremental');
    });

    it('selection follows the active editor and cursor (through the symlinked path)', async () => {
      const doc = await vscode.workspace.openTextDocument(path.join(workspace, 'src', 'app.ts'));
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(3, 0, 3, 0);
      const sel = await waitFor('selection', async () => {
        const s = (await state()).selection;
        return s.file === 'src/app.ts' && s.line === 3 && s;
      });
      assert.equal(sel.repo, realRoot);
    });

    it('blames a file in the worker and caches the result', async () => {
      type B = { lines: number; commits: number; cacheHit: boolean };
      const a = await vscode.commands.executeCommand<B>('gitvision._test.blame', realRoot, 'src/app.ts');
      assert.equal(a.lines, 12);
      assert.equal(a.commits, 2);
      const b = await vscode.commands.executeCommand<B>('gitvision._test.blame', realRoot, 'src/app.ts');
      assert.equal(b.cacheHit, true);
    });
  });
}
