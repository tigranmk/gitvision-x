# GitVision X

Line-level blame and a cursor-synced commit graph in one quiet, fast VS Code extension.
Product spec: [GitVision X — Technical Blueprint & Feature Spec](https://claude.ai/artifact/JkUs4T8Jbyg8oFHm8ude9T).
Build order and status: [PLAN.md](PLAN.md).

**Status: M0 (foundation).** No user-facing features yet. The extension indexes your repos'
history in the background; `GitVision: Show Commit Index Stats` shows the result.

## Develop

Requires Node 22, pnpm 10 and git ≥ 2.35.

```sh
pnpm install
pnpm build            # dist/extension.js + dist/worker.js
pnpm test             # unit tests (Vitest, real git in temp dirs)
pnpm test:integration # runs the extension in a downloaded VS Code
pnpm bench            # performance budgets on a generated 100k-commit repo
pnpm fixtures         # (re)generate test/fixtures/repos/
```

Press F5 in VS Code to launch an Extension Development Host.

## Layout

| Package | Runs in | Owns |
|---|---|---|
| `packages/protocol` | everywhere | RPC envelope (request/response/cancel/push), engine method types, selection model, dev-only zod validation |
| `packages/git-engine` | worker threads | git spawning, streaming log/blame parsers, columnar commit index, blame cache; `WorkerPool` is the host-side client |
| `packages/host` | extension host | activation, commands, `SelectionStore`, `.git` watchers |

Lint rules enforce the layer boundaries: the host never imports `child_process`, the engine never imports `vscode`,
and nothing calls `exec`/`*Sync` process APIs.

## License

MIT
