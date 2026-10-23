# Changelog

## 0.0.1 — first preview

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
