# GitVision X

**Who changed this line, and when, without leaving the code.**

GitVision X shows git blame for the line your cursor is on, quietly and fast. Hover it to see the line's
history. It's one free extension with no sidebars to manage, no CodeLens clutter and no paywalled views.

> **Preview.** Inline blame is ready to use. The cursor-synced commit graph, the time-travel slider and
> conflict resolution are still in development (see [Roadmap](#roadmap)).

## Features

### Blame on the current line

Stop on a line for a quarter of a second and its blame appears at the end of the line, in faded text:

```
const token = await refresh(session);      You, 3 days ago • Fix token refresh (#412)
```

- Only the current line is annotated, so the rest of the file stays clean.
- "You" is shown for your own commits, based on the repo's `user.email`.
- Lines you've added or edited and not committed yet show **Not committed yet**. Edits are tracked as
  you type; blame isn't re-run on every keystroke.
- Whitespace-only changes are ignored, and commits listed in your
  [`blame.ignoreRevsFile`](https://git-scm.com/docs/git-blame#Documentation/git-blame.txt---ignore-revs-fileltfilegt)
  are skipped (useful for formatting commits).

### Line history on hover

Hover the blame text to see:

- the author, date and full commit message;
- **Open diff** for that change, and **Copy SHA**;
- a timeline of the last 10 commits that touched the line, following renames, with a diff link for each;
- **moved from `path`** when the line came from another file.

### Select several lines for a summary

Select a block of code to see who wrote it and how old it is:

```
12 lines: 3 authors · You 60%, Ann 30% · oldest 2 years ago · newest 3 days ago
```

### Optional extras

- **Gutter heatmap:** colours the gutter by line age, from warm (recent) to cool (old).
- **Status bar author:** shows the current line's author at the bottom of the window.

## Getting started

1. Install the extension.
2. Open a folder that is a git repository.
3. Click any line in a file that git tracks.

It works with VS Code's built-in Git support and uses the same `git` executable. There's nothing to
configure.

## Commands

Open the Command Palette (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>) and type "GitVision".

| Command | What it does |
|---|---|
| **GitVision: Toggle Inline Blame** | Turns the current-line blame on or off. |
| **GitVision: Blame This File** | Blames a file over 20,000 lines, which is skipped automatically. |
| **GitVision: Show Commit Index Stats** | Shows how many commits are indexed for each open repository. |
| **GitVision: Rebuild Commit Index** | Rebuilds the commit index from scratch. |

## Settings

| Setting | Default | Description |
|---|---|---|
| `gitvision.blame.enabled` | `true` | Show blame as faded text on the current line. |
| `gitvision.blame.gutterHeatmap` | `false` | Colour the gutter by line age. |
| `gitvision.blame.statusBar` | `false` | Show the current line's author in the status bar. |
| `gitvision.blame.offerCommitGraph` | `true` | In repositories with 10,000+ commits, offer once to build git's commit-graph (see [Performance](#performance)). |

## Performance

GitVision X is designed to stay out of the editor's way:

- All git work runs in background threads, never on VS Code's extension host.
- A file's blame starts loading as soon as you open it, so it's usually ready before you stop on a line.
- Results stream in as git finds them. Recently changed lines appear first: in about 12 ms on a
  100,000-commit repository.
- Blame is saved between sessions, so reopening a file you've viewed before is instant.

The one slow case is the first-ever blame of a line that hasn't changed since early in a long history.
Git has to walk the whole history to find it: up to about 0.75 s on a 100,000-commit repository. In
large repositories GitVision offers once to let git build its **commit-graph with changed-path Bloom
filters**, which makes that walk roughly 40% faster. It runs `git commit-graph write`, a standard git
command, and never runs without your OK.

## Using it alongside GitLens

If GitLens is installed, GitVision asks once whether to turn off GitLens's current-line blame, so you
don't see blame twice. Nothing else in GitLens is changed, and you can decline.

## Privacy and data

- GitVision X sends nothing over the network and collects no telemetry.
- It keeps a commit index and a blame cache in VS Code's extension storage on your machine. The blame
  cache is capped at 256 MB.
- It never writes to your repository, except for the commit-graph file, and only if you accept that
  offer.

## Requirements

- VS Code 1.95 or newer
- git 2.35 or newer, available to VS Code's built-in Git extension
- A trusted folder: GitVision X is off in [Restricted Mode](https://code.visualstudio.com/docs/editor/workspace-trust)
  because a repository's git config can make git run programs, the same reason VS Code's built-in Git
  is disabled there.

## Known limitations

- The first-ever blame of very old lines in very large repositories can take up to about a second (see
  [Performance](#performance)).
- Files over 20,000 lines are only blamed on request (**GitVision: Blame This File**). Binary files are
  not blamed.
- Repositories using SHA-256 object names are not supported yet.
- Works with files on disk. Remote, virtual and web workspaces (such as vscode.dev) are not supported yet.

## Roadmap

| Milestone | Status |
|---|---|
| Inline blame with line history | Available (preview) |
| Commit graph that follows your cursor | In development |
| Time-travel slider for a file's history | Planned |
| Conflict resolution with a branch-structure map | Planned |

## Feedback and contributing

Found a bug or have an idea? [Open an issue](https://github.com/tigranmk/gitvision-x/issues).
Contributions are welcome: see [CONTRIBUTING.md](https://github.com/tigranmk/gitvision-x/blob/main/CONTRIBUTING.md).

## License

[MIT](LICENSE)
