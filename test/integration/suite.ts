import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface TestState {
  activationMs: number;
  workersStarted: number;
  repos: { info: { root: string; gitDir: string; commonDir: string }; stats: { commitCount: number; mode: string } | null }[];
  selection: { repo: string | null; file: string | null; line: number | null; commit: string | null };
  refsEvents: { root: string; mode: string }[];
  lastRender?: { uri: string; line: number; text: string; ms: number; warm: boolean };
}

// A remote extension host doesn't get the runner's env, so fall back to the window's folder.
const workspace = process.env.GVX_WORKSPACE ?? vscode.workspace.workspaceFolders![0]!.uri.fsPath;
const realRoot = (process.env.GVX_WORKSPACE_REAL ?? realpathSync.native(workspace)).replace(/\\/g, '/');
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
      const ext = vscode.extensions.getExtension('tigranmk.gitvision-x');
      assert.ok(ext, 'extension is installed');
      await ext.activate();
    });

    it('activates within the 30 ms budget', async () => {
      const s = await state();
      console.log(`      activate() took ${s.activationMs.toFixed(1)} ms (${process.platform})`);
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

  describe('F1 — inline blame', () => {
    const appPath = () => path.join(workspace, 'src', 'app.ts');
    let editor: vscode.TextEditor;

    async function rendered(line: number, match?: RegExp, uri = editor.document.uri) {
      try {
        return await waitFor(`ghost text on line ${line}`, async () => {
          const r = (await state()).lastRender;
          return r && r.uri === uri.toString() && r.line === line && (!match || match.test(r.text)) && r;
        });
      } catch (e) {
        const r = (await state()).lastRender;
        throw new Error(`${(e as Error).message} matching ${match}; last render: ${JSON.stringify(r && { file: path.basename(r.uri), line: r.line, text: r.text })}`, {
          cause: e,
        });
      }
    }
    const moveTo = (line: number, toLine = line) => {
      editor.selection = new vscode.Selection(line, 0, toLine, toLine === line ? 0 : 1);
    };

    before(async () => {
      editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(appPath()));
    });

    it('shows author, age and summary on the active line, from cache in < 16 ms', async () => {
      moveTo(0);
      // "You": the fixture's user.email is also its commits' author email.
      const first = await rendered(0, /^You, .+ ago • initial$/);
      assert.ok(first.text);
      moveTo(11);
      const r = await rendered(11, / • tweak app$/);
      assert.equal(r.warm, true, 'blame and line map were prefetched');
      console.log(`      warm render ${r.ms.toFixed(2)} ms`);
      assert.ok(r.ms < 16, `warm render took ${r.ms.toFixed(1)} ms`);
      assert.match((await state()).selection.commit ?? '', /^[0-9a-f]{40}$/);
    });

    it('prefetched blame when the file opened (cold time logged)', async () => {
      const b = await vscode.commands.executeCommand<{ known: boolean; coldMs: number; failure: string | null }>('gitvision._test.fileBlame', editor.document.uri);
      assert.equal(b.known, true);
      assert.equal(b.failure, null);
      console.log(`      open → blame ready ${b.coldMs.toFixed(1)} ms (small file)`);
    });

    it('remaps edited buffers: inserted lines are not committed, others keep their commit', async () => {
      await editor.edit((e) => e.insert(new vscode.Position(0, 0), '// new line\n'));
      moveTo(0);
      await rendered(0, /^Not committed yet$/);
      moveTo(1);
      await rendered(1, / • initial$/);
      // Not 'undo': that acts on whatever has focus, which in a remote window isn't always the editor.
      await editor.edit((e) => e.delete(new vscode.Range(0, 0, 1, 0)));
    });

    it('summarises a multi-line selection', async () => {
      moveTo(0, 11);
      await rendered(11, /^12 lines: You · oldest .+ · newest .+$/);
    });

    it('hover on the annotation shows the commit and the line history', async () => {
      moveTo(11);
      await rendered(11);
      const line = editor.document.lineAt(11);
      // Let the idle-time history preload land.
      await new Promise((r) => setTimeout(r, 500));
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', editor.document.uri, line.range.end);
      const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
      assert.match(text, /\*\*You \(Fixture Bot\)\*\*/);
      assert.match(text, /tweak app/);
      assert.match(text, /History of this line, last \d+/);
      assert.match(text, /command:gitvision\.blame\.openCommitDiff/);
    });

    it('untracked files show Not committed yet', async () => {
      const p = path.join(workspace, 'scratch.ts');
      writeFileSync(p, 'let x = 1;\n');
      editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(p));
      moveTo(0);
      await rendered(0, /^Not committed yet$/);
    });

    it('follows code moved from another file (-C) and refreshes after a commit', async () => {
      writeFileSync(path.join(workspace, 'src', 'lib.ts'), Array.from({ length: 8 }, (_, i) => `export const shared${i} = ${i * 10};`).join('\n') + '\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'add lib');
      const lines = Array.from({ length: 8 }, (_, i) => `export const shared${i} = ${i * 10};`);
      writeFileSync(path.join(workspace, 'src', 'lib.ts'), lines.slice(0, 2).join('\n') + '\n');
      writeFileSync(path.join(workspace, 'src', 'moved.ts'), lines.slice(2).join('\n') + '\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'split lib');
      editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(workspace, 'src', 'moved.ts')));
      moveTo(0);
      await rendered(0, / • add lib$/);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', editor.document.uri, editor.document.lineAt(0).range.end);
      const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
      assert.match(text, /moved from `src\/lib\.ts`/);

      // A new commit moves HEAD: blame must refresh without reopening the file.
      writeFileSync(path.join(workspace, 'src', 'moved.ts'), ['// header', ...lines.slice(2)].join('\n') + '\n');
      git('commit', '-qam', 'add header');
      // The editor reloads the file from disk; the inserted top line shifts the cursor, so wait for it first.
      await waitFor('reload from disk', async () => editor.document.lineAt(0).text === '// header');
      moveTo(0);
      await rendered(0, / • add header$/);
    });

    it('blames >20k-line files only on demand', async () => {
      const p = path.join(workspace, 'huge.txt');
      writeFileSync(p, Array.from({ length: 20_001 }, (_, i) => `row ${i}`).join('\n') + '\n');
      git('add', 'huge.txt');
      git('commit', '-qm', 'huge file');
      editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(p));
      const b = await waitFor('too-large outcome', async () => {
        const r = await vscode.commands.executeCommand<{ known: boolean; failure: string | null }>('gitvision._test.fileBlame', editor.document.uri);
        return r.known && r;
      });
      assert.equal(b.failure, 'too-large');
      await vscode.commands.executeCommand('gitvision.blame.blameFile');
      moveTo(5);
      await rendered(5, / • huge file$/);
    });
  });
}
