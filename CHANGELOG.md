# Changelog

## 0.1.0 — first public preview (2026-10-26)

### Commit graph, time travel and conflict resolution

- **Getting started walkthrough** and screenshots.
- **Accessibility:** hovering a lane names its branch; high-contrast themes outline rows and chips; buttons
  that can't run yet stay reachable by keyboard and say why; reduced motion turns animations off.
- **Wide graphs** squeeze their lanes to fit instead of cutting them off; narrow panels hide the date and
  author columns before the commit message.
- **Conflicts:** accept current / incoming / both, pick lines, compare and explain each conflict, with who
  changed it on each side; cards for delete/modify, rename/rename and binary conflicts; open in the 3-way
  merge editor; a conflict map in the graph with progress and Continue / Skip / Abort; the rebase step
  counter in the status bar.

- **Time travel:** step a file through its history in place (<kbd>Alt</kbd>+<kbd>[</kbd> / <kbd>Alt</kbd>+<kbd>]</kbd>,
  a slider in the panel, or a searchable list from the editor title). Added lines are tinted, removed lines
  shown in red, your place in the code kept; pin a revision to compare against it; renames followed.
- **Blame hover:** new **Time travel** and **Show in graph** links.

- **Commit graph** in the panel, or beside the editor. Smooth at 60 fps on 100,000+ commits.
- **Follows your cursor:** the current line's commit is highlighted as you move, and the line's whole
  history is ringed when you pause.
- **Commit details:** message, branches and tags, changed files with +/− counts (open files pinned),
  and a small side-by-side diff; double-click a file for the full diff.
- **Filters and search:** all branches, current branch, or the active file; <kbd>/</kbd> searches by
  message, author, SHA, or `path:`.
- **Git actions, always confirmed first:** check out, create branch or tag, cherry-pick, revert, reset,
  compare with HEAD; drag a branch onto another to merge or rebase.
- **Labels** for branches, remotes, tags, detached HEAD and other worktrees; **Fetch more** for shallow
  clones.
- **Keyboard** navigation and screen-reader support in the commit list.
- Fixed: **Open diff** from the blame hover showed an empty diff when the folder was opened through a
  symbolic link (for example under `/var` on macOS).

### Inline blame (built as 0.0.1, never published)

- **Blame on the current line:** author, age and commit message in faded text at the end of the line.
  Your own commits show as "You"; lines you haven't committed yet show **Not committed yet**, tracked
  as you type.
- **Line history on hover:** commit details, open the commit's diff, copy its SHA, and the line's last
  10 changes.
- **Selection summary:** select several lines to see their authors and date range.
- **Moved code:** lines copied or moved from another file are credited to the commit that wrote them.
- **Optional extras:** a gutter heatmap by line age and the current line's author in the status bar.
- **Fast on large repositories:** git runs in the background, never blocking the editor; blame appears
  as git finds it and is remembered between sessions. Repositories with 10,000+ commits get a one-time
  offer to speed up blame of old lines.
- **Works alongside GitLens:** offers once to turn off one of the two inline blames.
- **Remote-SSH** is supported. The extension is off in untrusted folders, because a repository's git
  config can make git run programs.
