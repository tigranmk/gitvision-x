# Contributing to GitVision X

Thanks for helping. This guide covers setting up the repo, how the code is organised, the rules that keep
the extension fast, and what a pull request needs.

- **Bugs and ideas:** [open an issue](https://github.com/tigranmk/gitvision-x/issues). For bugs, include
  your OS, VS Code and git versions, roughly how many commits the repository has, and the **GitVision**
  output channel log (View → Output → GitVision).
- **Larger changes:** open an issue first so we can agree on the approach.

## Setup

You need Node 22, pnpm 10 and git 2.35 or newer.

```sh
git clone https://github.com/tigranmk/gitvision-x.git
cd gitvision-x
pnpm install
pnpm build
```

To run the extension, open the folder in VS Code and press **F5**. That builds it and opens an
Extension Development Host window; open any git repository there. Logs go to the **GitVision** output
channel. Set the log level to Trace (Output panel → gear icon) to see per-file blame timings.

## Scripts

| Command | What it does |
|---|---|
| `pnpm build` | Dev build: `dist/extension.js` and `dist/worker.js`, with source maps and wire-message validation. |
| `pnpm build:prod` | Minified production build, without dev validation. |
| `pnpm watch` | Rebuilds on change. |
| `pnpm lint` / `pnpm typecheck` | ESLint, and TypeScript in strict mode. |
| `pnpm test` | Unit tests (Vitest) against real git repos created in temp directories. |
| `pnpm test:integration` | Runs the production build inside a downloaded VS Code. Set `VSCODE_VERSION=1.95.0` to test the minimum supported version. |
| `pnpm fixtures` | Generates the test repositories in `test/fixtures/repos/` (git-ignored), including a 100,000-commit one. |
| `node bench/run.mjs` | Performance benchmarks with budgets; fails if one is missed. |
| `pnpm package` | Builds a `.vsix` you can install with `code --install-extension`. |

## How the code is organised

| Package | Runs in | Responsible for |
|---|---|---|
| `packages/protocol` | everywhere | The RPC envelope (request, response, cancel, streamed partials, push), engine method types, the selection model, and dev-only zod validation |
| `packages/git-engine` | worker threads | Running git, streaming parsers, the commit index, blame and its caches. `WorkerPool` is the host-side client |
| `packages/host` | extension host | Activation, commands, `SelectionStore`, `.git` watching, blame rendering |

Requests are routed by repository, so a repo's state stays in one worker. Blame and index work run on
different workers, so loading a large index never delays blame.

### Rules the linter enforces

- The host never imports `child_process`; git runs only in the engine.
- The engine and protocol never import `vscode`.
- Nothing calls `exec` or any `*Sync` process API outside tests and scripts.

### Rules reviewers check

- **`activate()` does no I/O.** It must stay under 30 ms; the integration test asserts it.
- **Spawn git, never exec it, and stream its output.** Pass revisions to `--stdin` instead of the command
  line (Windows limits command-line length).
- **Anything over 64 KB crosses threads as a transferable buffer** (`withTransfer`), not as JSON.
- **Long-running requests take an `AbortSignal`**, and cancelling one must kill its git process.
- **Every git start costs about 4 ms on macOS and Linux, and 25–30 ms on Windows.** Don't add one to a
  hot path; cache what you can.

## Tests

- **Unit tests** sit next to the code (`*.test.ts`) and use real git through `test/unit/helpers/gitRepo.ts`.
  Prefer that to mocking git.
- **Integration tests** (`test/integration/suite.ts`) run against a throwaway copy of the `small` fixture.
  On macOS that copy deliberately keeps the `/var → /private/var` symlink, so path-resolution bugs show
  up. Test-only commands (`gitvision._test.*`) are registered only in test mode.
- **Fixtures** are generated, never committed. Add new ones to `scripts/fixtures.mjs` and describe them in
  `test/fixtures/README.md`.
- CI runs lint, typecheck, unit, benchmark and integration on Linux, macOS and Windows, plus the
  integration suite on VS Code 1.95.0.

## Performance budgets

`bench/bench.ts` holds the budgets: for example, a recently changed line's blame shown within 50 ms on a
100,000-commit repository, and a cold index load under 2 s. CI allows double the budget because shared
runners are slower and noisier. If your change moves a number, say so in the pull request and include
before/after output from `node bench/run.mjs`.

On macOS, run the benchmark with `node bench/run.mjs`, not `pnpm bench`. When running under a live
`pnpm` process, git takes about 30 ms to start instead of 4 ms there, for a reason not yet found. That
inflates every result that waits on git.

## Pull requests

1. Branch from `main`, and keep each PR to one change.
2. Make sure `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:integration` pass locally.
3. Add or update tests for what you changed. Bug fixes need a test that failed before the fix.
4. Update `CHANGELOG.md` for anything a user would notice, and the README if a command or setting changed.
5. If you made a design decision, explain it and the alternatives you rejected in the pull request description.

**Commit messages:** a short imperative subject line (under 72 characters), a blank line, then what
changed and why.

**Code style:** match the code around you. Comments explain why, not what. User-facing text is short and
specific: say what happened and what to do next, in sentence case.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
