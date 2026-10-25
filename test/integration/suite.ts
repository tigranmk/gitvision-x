import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface TestState {
  activationMs: number;
  workersStarted: number;
  repos: { info: { root: string; gitDir: string; commonDir: string }; stats: { commitCount: number; mode: string } | null }[];
  selection: { repo: string | null; file: string | null; line: number | null; commit: string | null; compareTo: string | null };
  refsEvents: { root: string; mode: string }[];
  lastRender?: { uri: string; line: number; text: string; ms: number; warm: boolean };
  graph?: { root: string | null; total: number; sync: { sha: string; seq: number } | null };
  graphSync?: { sha: string | null; seq: number; ms: number } | null;
  graphLineage?: { seq: number; shas: string[]; ms: number } | null;
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
      // Warm render is synchronous; one sample on a shared CI runner can catch a GC pause, so take five
      // (alternating lines) and hold the median to the budget.
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const line = i % 2 ? 0 : 11;
        moveTo(line);
        const r = await rendered(line, line ? / • tweak app$/ : / • initial$/);
        assert.equal(r.warm, true, 'blame and line map were prefetched');
        samples.push(r.ms);
      }
      const median = [...samples].sort((a, b) => a - b)[2]!;
      console.log(`      warm render ${samples.map((x) => x.toFixed(2)).join(', ')} ms (median ${median.toFixed(2)})`);
      assert.ok(median < 16, `warm render median ${median.toFixed(1)} ms (${samples.map((x) => x.toFixed(1)).join(', ')})`);
      moveTo(11);
      await rendered(11, / • tweak app$/);
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

      // A HEAD move re-blames the repo's files; the forced file must stay forced (it was dropped as too large).
      const events = (await state()).refsEvents.length;
      writeFileSync(path.join(workspace, 'other.txt'), 'x\n');
      git('add', 'other.txt');
      git('commit', '-qm', 'move HEAD');
      await waitFor('HEAD move synced', async () => (await state()).refsEvents.length > events);
      const after = await waitFor('re-blame of the forced file', async () => {
        const r = await vscode.commands.executeCommand<{ known: boolean; failure: string | null }>('gitvision._test.fileBlame', editor.document.uri);
        return r.known && r;
      });
      assert.equal(after.failure, null);
      moveTo(6);
      await rendered(6, / • huge file$/);
    });
  });
  describe('F2 — graph', () => {
    it('contributes the graph view and opens it beside the editor', async () => {
      // The panel view resolves its webview; its state follows the active repo and its commit count.
      await vscode.commands.executeCommand('gitvision.graph.focus');
      const g = await waitFor('graph state', async () => {
        const s = await state();
        const repo = s.repos.find((r) => r.info.root === realRoot);
        return s.graph?.root === realRoot && s.graph.total === repo?.stats?.commitCount && s.graph;
      });
      assert.ok(g.total > 5);

      // Editor → graph sync (D1): stage 1 from the blame cache, stage 2 (lineage) after the cursor rests.
      const doc = await vscode.workspace.openTextDocument(path.join(workspace, 'src', 'app.ts'));
      const ed = await vscode.window.showTextDocument(doc);
      await waitFor('blame of app.ts', async () => {
        const r = await vscode.commands.executeCommand<{ known: boolean; coldMs?: number }>('gitvision._test.fileBlame', doc.uri);
        return r.known && r.coldMs !== undefined;
      });
      const head = git('log', '-1', '--format=%H', '--', 'src/app.ts').trim();
      ed.selection = new vscode.Selection(11, 0, 11, 0); // a line from the last commit that touched app.ts
      const synced = await waitFor('graph sync', async () => {
        const s = await state();
        return s.graphSync?.sha === head && s.graph?.sync?.sha === head && s;
      });
      console.log(`      cursor → graph sync ${synced.graphSync!.ms.toFixed(1)} ms`);
      assert.ok(synced.graphSync!.ms < 100, `stage 1 took ${synced.graphSync!.ms.toFixed(1)} ms`);
      // A background sync may re-sync the cursor (new seq, old lineage cancelled): wait for the current one's.
      const lineage = await waitFor('lineage', async () => {
        const s = await state();
        const l = s.graphLineage;
        return s.graphSync?.sha === head && l?.seq === s.graphSync.seq && l;
      });
      console.log(`      lineage: ${lineage.shas.length} commits in ${lineage.ms.toFixed(0)} ms`);
      assert.ok(lineage.shas.includes(head), `the synced commit is part of its line lineage (${lineage.shas})`);

      // A HEAD move resets the graph and re-blames the file while the cursor stays put: the sync comes back
      // (new seq) without the cursor moving.
      const before = (await state()).graphSync!.seq;
      writeFileSync(path.join(workspace, 'other2.txt'), 'x\n');
      git('add', 'other2.txt');
      git('commit', '-qm', 'move HEAD again');
      await waitFor('graph re-synced after HEAD move', async () => {
        const s = await state();
        return s.graphSync?.sha === head && s.graphSync.seq > before && s.graph?.sync?.sha === head && s;
      });
      await waitFor('lineage after HEAD move', async () => {
        const s = await state();
        return s.graphLineage?.seq === s.graphSync?.seq && s.graphLineage!.shas.includes(head);
      });

      // Graph → editor: a modified file opens the diff editor; an added one opens its single revision.
      const tweak = git('log', '--format=%H', '--grep=^tweak app$').trim();
      const initial = git('rev-parse', `${tweak}^`).trim();
      await vscode.commands.executeCommand('gitvision._test.graphOpenDiff', { root: realRoot, sha: tweak, parent: initial, file: { path: 'src/app.ts', status: 'M' } });
      const diffTab = await waitFor('diff editor', async () =>
        vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputTextDiff && t.label.startsWith('app.ts')),
      );
      const diffInput = diffTab.input as vscode.TabInputTextDiff;
      assert.equal(diffInput.original.scheme, 'git');
      assert.equal(diffInput.modified.scheme, 'git');
      // The URIs must resolve in vscode.git's provider (the repo is opened through the /var symlink on macOS).
      assert.equal((await vscode.workspace.openTextDocument(diffInput.modified)).lineCount, 13);
      assert.equal((await vscode.workspace.openTextDocument(diffInput.original)).lineCount, 11);
      await vscode.window.tabGroups.close(diffTab);
      const featureSha = git('rev-parse', 'feature').trim();
      await vscode.commands.executeCommand('gitvision._test.graphOpenDiff', {
        root: realRoot,
        sha: featureSha,
        parent: git('rev-parse', `${featureSha}^`).trim(),
        file: { path: 'src/feature.ts', status: 'A' },
      });
      const added = await waitFor('added file editor', async () =>
        vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputText && t.input.uri.scheme === 'git'),
      );
      assert.equal((await vscode.workspace.openTextDocument((added.input as vscode.TabInputText).uri)).getText(), 'export const f = 1;\n');
      await vscode.window.tabGroups.close(added);

      await vscode.commands.executeCommand('gitvision.graph.openBeside');
      const tab = await waitFor('graph panel tab', async () =>
        vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((t) => t.label === 'Git Graph'),
      );
      assert.ok(tab.input instanceof vscode.TabInputWebview);
      await vscode.window.tabGroups.close(tab);
    });
  });
  describe('F2 — graph actions (context menu, drag and drop)', () => {
    const answer = (...a: (string | undefined)[]) => vscode.commands.executeCommand('gitvision._test.answer', ...a);
    const sha = (rev: string) => git('rev-parse', rev).trim();
    const ctx = (rev: string) => ({
      webviewSection: 'commit',
      root: realRoot,
      sha: sha(rev),
      subject: git('log', '-1', '--format=%s', rev).trim(),
      parents: git('log', '-1', '--format=%P', rev).trim().split(' ').length,
    });
    const lastWrite = async () => (await vscode.commands.executeCommand<{ lastWrite?: { op: { kind: string }; code?: string } }>('gitvision._test.state')).lastWrite;

    before(() => {
      git('reset', '-q', '--hard');
      git('checkout', '-q', 'main');
    });

    it('creates a branch and a tag at a commit', async () => {
      await answer('graph-test', 'Create');
      await vscode.commands.executeCommand('gitvision.graph.createBranch', ctx('HEAD~1'));
      assert.equal(sha('graph-test'), sha('HEAD~1'));
      await answer('v-test', 'Release notes');
      await vscode.commands.executeCommand('gitvision.graph.createTag', ctx('HEAD~1'));
      assert.equal(git('cat-file', '-t', 'v-test').trim(), 'tag');
      assert.equal(sha('v-test^{commit}'), sha('HEAD~1'));
    });

    it('does nothing when a confirmation is declined', async () => {
      const head = sha('HEAD');
      writeFileSync(path.join(workspace, 'keep.txt'), 'uncommitted\n');
      await answer('Hard', undefined); // pick Hard, then dismiss the modal
      await vscode.commands.executeCommand('gitvision.graph.reset', ctx('HEAD~1'));
      assert.equal(sha('HEAD'), head);
      assert.equal(readFileSync(path.join(workspace, 'keep.txt'), 'utf8'), 'uncommitted\n');
      const prompts = await vscode.commands.executeCommand<string[]>('gitvision._test.prompts');
      assert.ok(prompts.some((p) => /^Hard reset main to [0-9a-f]{7}\?$/.test(p)), prompts.join(' | '));
      rmSync(path.join(workspace, 'keep.txt'));
    });

    it('reverts and resets after confirmation', async () => {
      const head = sha('HEAD');
      await answer('Revert');
      await vscode.commands.executeCommand('gitvision.graph.revert', ctx('HEAD'));
      assert.match(git('log', '-1', '--format=%s').trim(), /^Revert /);
      await answer('Mixed', 'Reset');
      await vscode.commands.executeCommand('gitvision.graph.reset', ctx(head));
      assert.equal(sha('HEAD'), head);
    });

    it('checks out a commit detached, then a branch', async () => {
      // HEAD~1 has the graph-test branch on it, so checkout first asks which: pick the detached option.
      await answer(`Detached HEAD at ${sha('HEAD~1').slice(0, 7)}`, 'Check Out');
      await vscode.commands.executeCommand('gitvision.graph.checkout', ctx('HEAD~1'));
      assert.equal(git('branch', '--show-current').trim(), '');
      await answer('main');
      await vscode.commands.executeCommand('gitvision.graph.checkout', ctx('main'));
      assert.equal(git('branch', '--show-current').trim(), 'main');
    });

    it('merges a branch dropped onto the current one', async () => {
      git('checkout', '-q', '-b', 'drop-src');
      writeFileSync(path.join(workspace, 'dropped.txt'), 'x\n');
      git('add', 'dropped.txt');
      git('commit', '-qm', 'drop source');
      git('checkout', '-q', 'main');
      await answer('Merge drop-src into main', 'Merge');
      await vscode.commands.executeCommand('gitvision._test.dropBranch', {
        root: realRoot,
        source: { name: 'drop-src', kind: 'branch' },
        target: { name: 'main', kind: 'branch' },
      });
      assert.equal(sha('main'), sha('drop-src'));
    });

    it('compares a commit with HEAD in the multi-file diff editor', async () => {
      await vscode.commands.executeCommand('gitvision.graph.compareWithHead', ctx('HEAD~3'));
      const tab = await waitFor('changes editor', async () =>
        vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label.includes('↔ HEAD')),
      );
      assert.match(tab.label, /^[0-9a-f]{7} ↔ HEAD \(\d+ files?\)$/);
      await vscode.window.tabGroups.close(tab);
    });

    it('opens a commit (Enter in the graph) in the multi-file diff editor, root commit included', async () => {
      const root = git('rev-list', '--max-parents=0', 'HEAD').trim().split('\n')[0]!;
      await vscode.commands.executeCommand('gitvision._test.openCommit', realRoot, root);
      const tab = await waitFor('commit changes editor', async () =>
        vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label.startsWith(`${root.slice(0, 7)} initial`)),
      );
      await vscode.window.tabGroups.close(tab);
    });

    it('reports a cherry-pick that stops with conflicts', async () => {
      git('checkout', '-q', '-b', 'conflict-src', 'HEAD~1');
      writeFileSync(path.join(workspace, 'README.md'), 'theirs\n');
      git('commit', '-qam', 'theirs');
      git('checkout', '-q', 'main');
      writeFileSync(path.join(workspace, 'README.md'), 'ours\n');
      git('commit', '-qam', 'ours');
      await answer('Cherry-pick');
      await vscode.commands.executeCommand('gitvision.graph.cherryPick', ctx('conflict-src'));
      const w = await lastWrite();
      assert.equal(w?.op.kind, 'cherryPick');
      assert.equal(w?.code, 'conflict');
      git('cherry-pick', '--abort');
    });
  });
  describe('F3 — time travel', () => {
    const fixtures = path.resolve(__dirname, '../../test/fixtures/repos');
    const clones: string[] = [];
    const clone = (name: string) => {
      const dir = mkdtempSync(path.join(tmpdir(), `gvx-tt-${name}-`));
      execFileSync('git', ['clone', '-q', path.join(fixtures, name), dir]);
      clones.push(dir);
      return realpathSync.native(dir).replace(/\\/g, '/');
    };
    type Step = { index: number; ms: number; mappedLine: number | null; added: number; removed: number; uri: string };
    type TT = { session: { path: string; index: number; count: number; pinned: unknown } | null; lastStep: Step | null };
    const tt = () => vscode.commands.executeCommand<TT>('gitvision._test.timeTravel');
    const stepTo = async (cmd: string, index: number) => {
      await vscode.commands.executeCommand(cmd);
      return waitFor(`time travel at ${index}`, async () => {
        const t = await tt();
        return t.session?.index === index && t.lastStep?.index === index && t.lastStep;
      });
    };
    const gitIn = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

    after(() => {
      for (const d of clones) rmSync(d, { recursive: true, force: true });
    });

    it('steps a renamed file back through its history, then returns to the working copy', async () => {
      const root = clone('renames');
      await vscode.commands.executeCommand('gitvision._test.openRepo', root);
      const working = await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'lib/helpers.ts')));
      const revs = gitIn(root, 'log', '--follow', '--format=%H', '--', 'lib/helpers.ts').trim().split('\n');

      const first = await stepTo('gitvision.timeTravel.back', 0);
      let ed = vscode.window.activeTextEditor!;
      assert.equal(ed.document.uri.scheme, 'gitvision');
      assert.equal(ed.document.uri.authority, revs[0]);
      assert.equal(ed.document.getText(), gitIn(root, 'show', `${revs[0]}:lib/helpers.ts`));
      assert.ok(first.added + first.removed > 0, 'the newest revision shows what it changed');

      // Back to the oldest revision: before two renames, at src/util.ts.
      for (let i = 1; i < revs.length; i++) await stepTo('gitvision.timeTravel.back', i);
      ed = vscode.window.activeTextEditor!;
      assert.ok(ed.document.uri.path.endsWith('/src/util.ts'), ed.document.uri.toString());
      assert.equal(ed.document.getText(), gitIn(root, 'show', `${revs.at(-1)}:src/util.ts`));
      await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(ed.document.uri, new Uint8Array([1]))), 'revisions are read-only');

      await stepTo('gitvision.timeTravel.forward', revs.length - 2);
      await vscode.commands.executeCommand('gitvision.timeTravel.togglePin');
      assert.ok((await tt()).session!.pinned);
      assert.equal((await state()).selection.compareTo, revs[revs.length - 2]);

      await vscode.commands.executeCommand('gitvision.timeTravel.exit');
      await waitFor('back on the working copy', async () => !(await tt()).session && vscode.window.activeTextEditor?.document.uri.toString() === working.document.uri.toString());
      assert.ok(!vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputText && t.input.uri.scheme === 'gitvision'));
    });

    it('steps through 500 revisions within budget (gate: p95 < 120 ms), keeping the reader’s place', async () => {
      const root = clone('revisions-500');
      await vscode.commands.executeCommand('gitvision._test.openRepo', root);
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'notes.md')));
      // Scroll into the file (VS Code keeps some context above a revealed line, so read where it landed).
      const topLine = await waitFor('scrolled into the file', async () => {
        editor.revealRange(new vscode.Range(30, 0, 30, 0), vscode.TextEditorRevealType.AtTop);
        const top = editor.visibleRanges[0]?.start.line ?? 0;
        return top >= 20 && top;
      });
      const samples: number[] = [];
      await stepTo('gitvision.timeTravel.back', 0);
      for (let i = 1; i <= 40; i++) {
        const last = await stepTo('gitvision.timeTravel.back', i);
        samples.push(last.ms);
        // Each revision moves a marker between two of the 60 lines: two added, two removed; the reader stays put.
        assert.equal(last.added, 2);
        assert.equal(last.removed, 2);
        assert.ok(Math.abs((last.mappedLine ?? 0) - topLine) <= 1, `mapped to ${last.mappedLine}, reader was at ${topLine}`);
      }
      for (let i = 39; i >= 30; i--) samples.push((await stepTo('gitvision.timeTravel.forward', i)).ms);
      const sorted = [...samples].sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
      console.log(`      step: median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms over ${samples.length} steps`);
      const slack = process.env.CI ? 2 : 1;
      assert.ok(p95 < 120 * slack, `step p95 ${p95.toFixed(1)} ms`);

      // From the blame hover: travel straight to a revision.
      const sha = gitIn(root, 'log', '--format=%H', '--grep=^Revision 250$').trim();
      await vscode.commands.executeCommand('gitvision.timeTravel.openAt', { root, path: 'notes.md', sha });
      await waitFor('revision 250', async () => (await tt()).lastStep?.uri.includes(sha) ?? false);
      await vscode.commands.executeCommand('gitvision.timeTravel.exit');
    });
  });
}
