// Generates the fixture repos under test/fixtures/repos/ (git-ignored; rebuilt on demand).
//   node scripts/fixtures.mjs                 build missing fixtures
//   node scripts/fixtures.mjs --force         rebuild all
//   node scripts/fixtures.mjs --only big-100k,octopus
// Deterministic: fixed authors and timestamps, so SHAs are stable across machines.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'repos');

const args = process.argv.slice(2);
const force = args.includes('--force');
const onlyArg = args.find((a) => a.startsWith('--only'));
const only = onlyArg ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1]).split(',') : null;

const BASE_TIME = 1_600_000_000;
const AUTHORS = Array.from({ length: 30 }, (_, i) => [`Dev ${String.fromCharCode(65 + (i % 26))}${i}`, `dev${i}@example.com`]);
const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture Bot',
  GIT_AUTHOR_EMAIL: 'bot@example.com',
  GIT_COMMITTER_NAME: 'Fixture Bot',
  GIT_COMMITTER_EMAIL: 'bot@example.com',
};

let tick = 0;
function git(cwd, argv, input) {
  const env = { ...ENV, GIT_AUTHOR_DATE: `${BASE_TIME + ++tick * 60} +0000`, GIT_COMMITTER_DATE: `${BASE_TIME + tick * 60} +0000` };
  const r = spawnSync('git', argv, { cwd, env, input, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed in ${cwd}:\n${r.stderr}`);
  return r.stdout;
}
function init(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'user.name', 'Fixture Bot']);
  git(dir, ['config', 'user.email', 'bot@example.com']);
}
function write(dir, file, content) {
  const p = path.join(dir, file);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}
function commit(dir, msg, files = {}) {
  for (const [f, c] of Object.entries(files)) write(dir, f, c);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', msg]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n') + '\n';

/** git fast-import stream writer: blobs inline, marks per commit. */
class FastImport {
  constructor() {
    this.parts = [];
    this.mark = 0;
  }
  commit(ref, { author, time, message, from, merges = [], files = {} }) {
    const m = ++this.mark;
    const [name, email] = author;
    const msg = Buffer.from(message);
    this.parts.push(`commit ${ref}\nmark :${m}\nauthor ${name} <${email}> ${time} +0000\ncommitter ${name} <${email}> ${time} +0000\ndata ${msg.length}\n${message}\n`);
    if (from) this.parts.push(`from :${from}\n`);
    for (const p of merges) this.parts.push(`merge :${p}\n`);
    for (const [file, content] of Object.entries(files)) {
      const data = Buffer.from(content);
      this.parts.push(`M 100644 inline ${file}\ndata ${data.length}\n${content}\n`);
    }
    this.parts.push('\n');
    return m;
  }
  run(dir) {
    git(dir, ['fast-import', '--quiet', '--done'], this.parts.join('') + 'done\n');
    git(dir, ['reset', '-q', '--hard', 'main']);
  }
}

const builders = {
  /** ~100k commits: a main line with a 3-commit side branch merged back every 50 commits. */
  'big-100k'(dir) {
    init(dir);
    const fi = new FastImport();
    const TOTAL = 100_000;
    const hot = Array.from({ length: 200 }, (_, i) => `export const line${i} = ${i};`);
    let head = 0;
    let n = 0;
    const next = (ref, extra) => {
      n++;
      const files = { [`src/m${n % 40}/f${n % 200}.ts`]: `// rev ${n}\nexport const v = ${n};\n` };
      if (n % 20 === 0) {
        hot[n % 200] = `export const line${n % 200} = ${n};`;
        files['src/hot.ts'] = hot.join('\n') + '\n';
      }
      return fi.commit(ref, { author: AUTHORS[n % AUTHORS.length], time: BASE_TIME + n * 60, message: `Change ${n}: update module ${n % 40}`, files, ...extra });
    };
    while (n < TOTAL) {
      if (n > 0 && n % 50 === 0 && n + 4 <= TOTAL) {
        const base = head;
        let side = next('refs/heads/side', { from: base });
        side = next('refs/heads/side', { from: side });
        side = next('refs/heads/side', { from: side });
        head = next('refs/heads/main', { from: base, merges: [side] });
        continue;
      }
      head = next('refs/heads/main', head ? { from: head } : {});
    }
    fi.run(dir);
    for (let v = 1; v <= 20; v++) git(dir, ['tag', `v${v}.0`, `main~${v * 2000}`]);
    git(dir, ['branch', '-D', 'side']);
  },

  /**
   * ~100k commits on 24 feature branches worked on in parallel: each runs 5–300 commits, merges into
   * main and starts again from main; all 24 are still open at the end. The graph's many-lane case.
   */
  'wide-100k'(dir) {
    init(dir);
    const fi = new FastImport();
    const TOTAL = 100_000;
    const BRANCHES = 24;
    let seed = 42;
    const rand = (k) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 12) % k;
    let n = 0;
    const next = (ref, extra, message) => {
      n++;
      const files = { [`src/f${n % 500}.ts`]: `export const v = ${n};\n` };
      return fi.commit(ref, { author: AUTHORS[n % AUTHORS.length], time: BASE_TIME + n * 60, message: message ?? `Change ${n}`, files, ...extra });
    };
    let main = next('refs/heads/main', {}, 'initial');
    const tip = new Array(BRANCHES).fill(0);
    const left = Array.from({ length: BRANCHES }, () => 5 + rand(296));
    while (n < TOTAL) {
      const b = rand(BRANCHES);
      const ref = `refs/heads/feature-${b}`;
      if (left[b] > 0 || n + 2 >= TOTAL) {
        tip[b] = next(ref, { from: tip[b] || main });
        left[b]--;
      } else {
        main = next('refs/heads/main', { from: main, merges: [tip[b]] }, `Merge feature-${b}`);
        tip[b] = 0;
        left[b] = 5 + rand(296);
      }
    }
    fi.run(dir);
  },

  /**
   * The 12 conflict scenarios (M4 gate): branches <name>-base, <name>-ours, <name>-theirs per scenario, each
   * touching only its own files. Tests merge (or rebase) theirs into ours to stop at the conflict. See
   * test/fixtures/README.md for the list.
   */
  conflicts(dir) {
    init(dir);
    commit(dir, 'root', { 'README.md': '# conflicts\n' });
    const ten = (tag, changed = {}) => lines(10, (i) => (changed[i] !== undefined ? changed[i] : `${tag} line ${i}`));
    const bin = (n) => Buffer.from(Array.from({ length: 64 }, (_, i) => (i === 0 ? 0 : (i * n) % 256)));
    const scenario = (name, base, ours, theirs) => {
      git(dir, ['checkout', '-q', '-b', `${name}-base`, 'main']);
      apply(dir, base);
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '-m', `${name}: base`]);
      for (const [side, change] of [['ours', ours], ['theirs', theirs]]) {
        git(dir, ['checkout', '-q', '-b', `${name}-${side}`, `${name}-base`]);
        apply(dir, change);
        git(dir, ['add', '-A']);
        git(dir, ['commit', '-q', '-m', `${name}: ${side}`]);
      }
    };
    // change: { file: content | null (delete) | { renameTo } }
    const apply = (d, change) => {
      for (const [f, c] of Object.entries(change)) {
        if (c === null) git(d, ['rm', '-q', f]);
        else if (c && typeof c === 'object' && 'renameTo' in c) {
          mkdirSync(path.dirname(path.join(d, c.renameTo)), { recursive: true });
          git(d, ['mv', f, c.renameTo]);
        } else write(d, f, c);
      }
    };
    for (const kind of ['m', 'r']) {
      scenario(`${kind}-simple`, { [`${kind}-simple.txt`]: ten('s') }, { [`${kind}-simple.txt`]: ten('s', { 4: 'ours line 4' }) }, { [`${kind}-simple.txt`]: ten('s', { 4: 'theirs line 4' }) });
      // Changes 10 lines apart: git keeps them as three hunks (closer ones it joins into one).
      const many = (tag, changed = {}) => lines(24, (i) => (changed[i] !== undefined ? changed[i] : `${tag} line ${i}`));
      scenario(
        `${kind}-multi`,
        { [`${kind}-multi.txt`]: many('m') },
        { [`${kind}-multi.txt`]: many('m', { 1: 'ours 1', 11: 'ours 11', 21: 'ours 21' }) },
        { [`${kind}-multi.txt`]: many('m', { 1: 'theirs 1', 11: 'theirs 11', 21: 'theirs 21' }) },
      );
      scenario(`${kind}-diff3`, { [`${kind}-diff3.txt`]: ten('d') }, { [`${kind}-diff3.txt`]: ten('d', { 3: 'ours 3' }) }, { [`${kind}-diff3.txt`]: ten('d', { 3: 'theirs 3' }) });
      scenario(
        `${kind}-delete-modify`,
        { [`${kind}-dm.txt`]: ten('dm') },
        { [`${kind}-dm.txt`]: ten('dm', { 2: 'ours edit' }) },
        { [`${kind}-dm.txt`]: null },
      );
      scenario(`${kind}-binary`, { [`${kind}-b.bin`]: bin(3) }, { [`${kind}-b.bin`]: bin(5) }, { [`${kind}-b.bin`]: bin(7) });
    }
    scenario(
      'm-zdiff3',
      { 'm-zdiff3.txt': ten('z') },
      { 'm-zdiff3.txt': ten('z', { 6: 'ours 6a\nours 6b' }) },
      { 'm-zdiff3.txt': ten('z', { 6: 'theirs 6a\ntheirs 6b' }) },
    );
    scenario('m-rename-rename', { 'm-rr.txt': ten('rr') }, { 'm-rr.txt': { renameTo: 'm-rr-ours.txt' } }, { 'm-rr.txt': { renameTo: 'm-rr-theirs.txt' } });
    git(dir, ['checkout', '-q', 'main']);
  },

  /** An octopus merge of three branches, plus an unrelated orphan root merged in. */
  octopus(dir) {
    init(dir);
    commit(dir, 'root', { 'a.txt': 'a\n' });
    for (const b of ['one', 'two', 'three']) {
      git(dir, ['checkout', '-q', '-b', b, 'main']);
      commit(dir, `work on ${b}`, { [`${b}.txt`]: `${b}\n` });
    }
    git(dir, ['checkout', '-q', 'main']);
    git(dir, ['merge', '-q', '--no-edit', 'one', 'two', 'three']);
    git(dir, ['checkout', '-q', '--orphan', 'docs']);
    git(dir, ['rm', '-rq', '--cached', '.']);
    rmSync(path.join(dir, 'a.txt'));
    for (const b of ['one', 'two', 'three']) rmSync(path.join(dir, `${b}.txt`));
    commit(dir, 'docs root', { 'docs/index.md': '# Docs\n' });
    git(dir, ['checkout', '-q', '-f', 'main']);
    git(dir, ['merge', '-q', '--no-edit', '--allow-unrelated-histories', 'docs']);
  },

  /** A file renamed twice with edits, and a block moved to another file (for blame -C). */
  renames(dir) {
    init(dir);
    commit(dir, 'add util', { 'src/util.ts': lines(30, (i) => `export const u${i} = ${i};`) });
    commit(dir, 'edit util', { 'src/util.ts': lines(30, (i) => `export const u${i} = ${i * 2};`) });
    git(dir, ['mv', 'src/util.ts', 'src/helpers.ts']);
    commit(dir, 'rename util → helpers');
    commit(dir, 'edit helpers', { 'src/helpers.ts': lines(30, (i) => (i === 3 ? 'export const u3 = 333;' : `export const u${i} = ${i * 2};`)) });
    mkdirSync(path.join(dir, 'lib'));
    git(dir, ['mv', 'src/helpers.ts', 'lib/helpers.ts']);
    commit(dir, 'move helpers to lib');
    // Move lines 20-29 into a new file.
    commit(dir, 'split helpers', {
      'lib/helpers.ts': lines(20, (i) => (i === 3 ? 'export const u3 = 333;' : `export const u${i} = ${i * 2};`)),
      'lib/more.ts': lines(10, (i) => `export const u${i + 20} = ${(i + 20) * 2};`),
    });
  },

  /** Linked worktree on a branch, plus one with a detached HEAD. */
  worktrees(dir) {
    for (const d of ['worktrees-feature', 'worktrees-detached']) rmSync(path.join(dir, '..', d), { recursive: true, force: true });
    init(dir);
    commit(dir, 'one', { 'a.txt': '1\n' });
    commit(dir, 'two', { 'a.txt': '2\n' });
    git(dir, ['branch', 'feature']);
    git(dir, ['worktree', 'add', '-q', path.join(dir, '..', 'worktrees-feature'), 'feature']);
    git(dir, ['worktree', 'add', '-q', '--detach', path.join(dir, '..', 'worktrees-detached'), 'HEAD~1']);
  },

  /** One file with 500 revisions (time-travel bucketing). */
  'revisions-500'(dir) {
    init(dir);
    const fi = new FastImport();
    let head = 0;
    for (let i = 1; i <= 500; i++) {
      head = fi.commit('refs/heads/main', {
        author: AUTHORS[i % 5],
        time: BASE_TIME + i * 86_400,
        message: `Revision ${i}`,
        from: head || undefined,
        files: { 'notes.md': lines(60, (l) => (l === i % 60 ? `line ${l} (rev ${i})` : `line ${l}`)) },
      });
    }
    fi.run(dir);
  },

  /** 20k-line file (blame on demand only) and a binary file. */
  'large-files'(dir) {
    init(dir);
    commit(dir, 'add big', { 'big.txt': lines(20_000, (i) => `row ${i}`) });
    commit(dir, 'touch big', { 'big.txt': lines(20_001, (i) => `row ${i}${i === 10 ? ' edited' : ''}`) });
    write(dir, 'image.bin', Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256)));
    commit(dir, 'add binary');
    write(dir, 'image.bin', Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 13) % 256)));
    commit(dir, 'change binary');
  },

  /** Small repo with two branches and a merge; the integration-test workspace. */
  small(dir) {
    init(dir);
    commit(dir, 'initial', { 'src/app.ts': lines(10, (i) => `export const a${i} = ${i};`), 'README.md': '# small\n' });
    commit(dir, 'tweak app', { 'src/app.ts': lines(12, (i) => `export const a${i} = ${i};`) });
    git(dir, ['checkout', '-q', '-b', 'feature']);
    commit(dir, 'feature work', { 'src/feature.ts': 'export const f = 1;\n' });
    git(dir, ['checkout', '-q', 'main']);
    commit(dir, 'main work', { 'README.md': '# small\n\nmore\n' });
    git(dir, ['merge', '-q', '--no-edit', 'feature']);
  },

  /** Shallow clone (depth 3) of `renames`. */
  shallow(dir) {
    ensure('renames');
    rmSync(dir, { recursive: true, force: true });
    git(FIXTURES, ['clone', '-q', '--depth=3', pathToFileURL(path.join(FIXTURES, 'renames')).href, dir]);
  },

  /** Blobless partial clone of `renames` (blobs fetched lazily). */
  partial(dir) {
    ensure('renames');
    rmSync(dir, { recursive: true, force: true });
    git(path.join(FIXTURES, 'renames'), ['config', 'uploadpack.allowFilter', 'true']);
    git(FIXTURES, ['clone', '-q', '--filter=blob:none', '--no-checkout', pathToFileURL(path.join(FIXTURES, 'renames')).href, dir]);
  },
};

const built = new Set();
function ensure(name) {
  if (built.has(name)) return;
  const dir = path.join(FIXTURES, name);
  if (!force && existsSync(path.join(dir, '.git'))) {
    built.add(name);
    return;
  }
  const t = performance.now();
  builders[name](dir);
  built.add(name);
  console.log(`fixture ${name}: ${Math.round(performance.now() - t)} ms`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  mkdirSync(FIXTURES, { recursive: true });
  for (const name of only ?? Object.keys(builders)) {
    if (!builders[name]) throw new Error(`Unknown fixture ${name}; known: ${Object.keys(builders).join(', ')}`);
    ensure(name);
  }
}
