<script lang="ts">
  import { isCancelled, relativeTime, type GraphCommitDetails, type GraphFile, type GraphRef, type MicroDiff as Diff } from '@gvx/protocol';
  import { buildTree, flatten } from './fileTree';
  import MicroDiff from './MicroDiff.svelte';
  import type { HostRpc } from './rpc';

  let {
    rpc,
    root,
    sha,
    refs,
    openFiles,
    userEmail,
    onJump,
    onClose,
  }: {
    rpc: HostRpc;
    root: string;
    sha: string;
    refs: GraphRef[];
    /** Repo-relative paths open in editor tabs, pushed by the host as tabs change. */
    openFiles: ReadonlySet<string> | null;
    userEmail: string | null;
    onJump: (sha: string) => void;
    onClose: () => void;
  } = $props();

  let details = $state.raw<GraphCommitDetails | null>(null);
  let error = $state<string | null>(null);
  let collapsed = $state.raw(new Set<string>());
  let selectedFile = $state<string | null>(null);
  /** File under the pointer (after a short delay), previewed instead of the selected one. */
  let hoveredFile = $state<string | null>(null);
  let diff = $state.raw<{ path: string; diff: Diff | null; error: string | null } | null>(null);
  const diffs = new Map<string, Diff>();
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  const HOVER_DELAY_MS = 150;
  const now = Math.floor(Date.now() / 1000);

  $effect(() => {
    const controller = new AbortController();
    const want = sha;
    details = null;
    error = null;
    selectedFile = null;
    hoveredFile = null;
    diffs.clear();
    rpc.request('graph.details', { root, sha: want }, { signal: controller.signal }).then(
      (d) => (details = d),
      (e) => {
        if (!isCancelled(e)) error = (e as Error).message;
      },
    );
    return () => controller.abort();
  });

  // Micro-diff of the hovered file, else the selected one; fetched once per file, cancelled when it changes.
  const shownFile = $derived(details?.files.find((f) => f.path === (hoveredFile ?? selectedFile)) ?? null);
  $effect(() => {
    const f = shownFile;
    if (!f) {
      diff = null;
      return;
    }
    const cached = diffs.get(f.path);
    if (cached) {
      diff = { path: f.path, diff: cached, error: null };
      return;
    }
    diff = { path: f.path, diff: null, error: null };
    const controller = new AbortController();
    rpc.request('graph.fileDiff', { root, sha, path: f.path, oldPath: f.oldPath }, { signal: controller.signal }).then(
      (d) => {
        diffs.set(f.path, d);
        if (diff?.path === f.path) diff = { path: f.path, diff: d, error: null };
      },
      (e) => {
        if (!isCancelled(e) && diff?.path === f.path) diff = { path: f.path, diff: null, error: (e as Error).message };
      },
    );
    return () => controller.abort();
  });

  function hover(path: string | null) {
    clearTimeout(hoverTimer);
    if (path === null) hoveredFile = null;
    else hoverTimer = setTimeout(() => (hoveredFile = path), HOVER_DELAY_MS);
  }

  function openDiff(f: GraphFile) {
    void rpc.request('graph.openDiff', { root, sha, parent: details?.parents[0] ?? null, file: { path: f.path, oldPath: f.oldPath, status: f.status } });
  }

  const subject = $derived(details?.message.split('\n')[0] ?? '');
  const body = $derived(details?.message.split('\n').slice(1).join('\n').trim() ?? '');
  // The host marks files open at request time; later tab changes arrive as openFiles.
  const isOpen = (f: GraphFile) => (openFiles ? openFiles.has(f.path) : f.open);
  const pinned = $derived(details?.files.filter(isOpen) ?? []);
  const rows = $derived(details ? flatten(buildTree(details.files), collapsed) : []);
  const totals = $derived(details?.files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 }));

  const who = (name: string, mail: string) => (userEmail && mail.toLowerCase() === userEmail.toLowerCase() ? 'You' : name);
  const when = (t: number) => `${relativeTime(t, now)} (${new Date(t * 1000).toLocaleString()})`;

  function toggle(path: string) {
    const next = new Set(collapsed);
    if (!next.delete(path)) next.add(path);
    collapsed = next;
  }

  function copySha() {
    void rpc.request('clipboard.write', { text: sha });
  }

  const STATUS: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' };
</script>

<aside class="details" aria-label="Commit details">
  <header>
    <h2 title={subject}>{subject || sha.slice(0, 7)}</h2>
    <button class="icon" title="Close details" aria-label="Close details" onclick={onClose}><i class="codicon codicon-close"></i></button>
  </header>

  {#if error}
    <p class="muted">{error}</p>
  {:else if !details}
    <p class="muted">Loading…</p>
  {:else}
    {#if refs.length}
      <div class="refs">
        {#each refs as ref (ref.kind + ref.name)}
          <span class="ref {ref.kind}"><i class="codicon codicon-{ref.kind === 'tag' ? 'tag' : ref.kind === 'remote' ? 'cloud' : 'git-branch'}"></i>{ref.name}</span>
        {/each}
      </div>
    {/if}
    <dl>
      <dt>Author</dt>
      <dd>{who(details.author, details.authorMail)} <span class="muted">&lt;{details.authorMail}&gt;</span>, {when(details.authorTime)}</dd>
      {#if details.committerMail !== details.authorMail || details.commitTime !== details.authorTime}
        <dt>Committer</dt>
        <dd>{who(details.committer, details.committerMail)}, {when(details.commitTime)}</dd>
      {/if}
      <dt>Commit</dt>
      <dd>
        <code>{sha.slice(0, 12)}</code>
        <button class="icon" title="Copy SHA" aria-label="Copy SHA" onclick={copySha}><i class="codicon codicon-copy"></i></button>
      </dd>
      {#if details.parents.length}
        <dt>{details.parents.length > 1 ? 'Parents' : 'Parent'}</dt>
        <dd>
          {#each details.parents as p (p)}
            <button class="link" title="Go to {p.slice(0, 7)}" onclick={() => onJump(p)}><code>{p.slice(0, 7)}</code></button>
          {/each}
        </dd>
      {/if}
    </dl>
    {#if body}<pre class="body">{body}</pre>{/if}

    <section class="files" aria-label="Changed files">
      <h3>
        {details.files.length + details.filesTruncated} {details.files.length + details.filesTruncated === 1 ? 'file' : 'files'} changed
        <span class="added">+{totals!.added}</span> <span class="removed">−{totals!.removed}</span>
        {#if details.parents.length > 1}<span class="muted">(against the first parent)</span>{/if}
      </h3>
      {#if pinned.length}
        <h4>Open in editor</h4>
        <ul role="tree" aria-label="Changed files open in the editor">
          {#each pinned as f (f.path)}
            {@render fileRow(f, f.path, 0)}
          {/each}
        </ul>
        <h4>All files</h4>
      {/if}
      <ul role="tree" aria-label="All changed files">
        {#each rows as { node, depth } (node.path)}
          {#if node.file}
            {@render fileRow(node.file, node.name, depth)}
          {:else}
            <li role="treeitem" aria-selected="false" aria-expanded={!collapsed.has(node.path)}>
              <button class="row-button" style:padding-left="{depth * 12 + 4}px" onclick={() => toggle(node.path)}>
                <i class="codicon codicon-chevron-{collapsed.has(node.path) ? 'right' : 'down'}"></i>
                <i class="codicon codicon-folder"></i>
                <span class="name">{node.name}</span>
              </button>
            </li>
          {/if}
        {/each}
      </ul>
      {#if details.filesTruncated}<p class="muted">…and {details.filesTruncated} more files.</p>{/if}
    </section>
    {#if diff}
      <MicroDiff path={diff.path} diff={diff.diff} error={diff.error} />
    {/if}
  {/if}
</aside>

{#snippet fileRow(f: GraphFile, label: string, depth: number)}
  <li role="treeitem" aria-selected={selectedFile === f.path} class:selected={selectedFile === f.path}>
    <button
      class="row-button"
      style:padding-left="{depth * 12 + 20}px"
      title="{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path} (double-click or Enter for the full diff)"
      onclick={() => (selectedFile = f.path)}
      ondblclick={() => openDiff(f)}
      onkeydown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          openDiff(f);
        }
      }}
      onpointerenter={() => hover(f.path)}
      onpointerleave={() => hover(null)}
    >
      <span class="status s-{f.status}" title={STATUS[f.status] ?? f.status}>{f.status}</span>
      <span class="name">{label}</span>
      {#if isOpen(f)}<i class="codicon codicon-circle-filled open-badge" title="Open in editor" aria-label="open in editor"></i>{/if}
      <span class="counts">
        {#if f.binary}<span class="muted">binary</span>{:else}<span class="added">+{f.added}</span> <span class="removed">−{f.removed}</span>{/if}
      </span>
    </button>
  </li>
{/snippet}

<style>
  .details {
    overflow-y: auto;
    padding: var(--gvx-space-2) var(--gvx-space-3);
    background: var(--gvx-surface);
    border-left: 1px solid var(--gvx-border);
    box-sizing: border-box;
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: var(--gvx-space-2);
  }
  h2 {
    flex: 1;
    margin: 0;
    font-size: 1.1em;
    font-weight: 600;
    line-height: 1.4;
  }
  h3,
  h4 {
    margin: var(--gvx-space-3) 0 var(--gvx-space-1);
    font-size: 1em;
    font-weight: 600;
  }
  h4 {
    font-weight: normal;
    color: var(--gvx-text-muted);
    font-size: 0.92em;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--gvx-space-1) var(--gvx-space-3);
    margin: var(--gvx-space-2) 0;
  }
  dt {
    color: var(--gvx-text-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  code {
    font-family: var(--gvx-font-mono);
  }
  .body {
    white-space: pre-wrap;
    font-family: var(--gvx-font);
    margin: var(--gvx-space-2) 0;
  }
  .muted {
    color: var(--gvx-text-muted);
  }
  .added {
    color: var(--gvx-added);
  }
  .removed {
    color: var(--gvx-removed);
  }
  .refs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gvx-space-1);
    margin-top: var(--gvx-space-2);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li.selected .row-button {
    background: var(--gvx-selection);
    color: var(--gvx-selection-text);
  }
  .row-button {
    display: flex;
    align-items: center;
    gap: var(--gvx-space-1);
    width: 100%;
    height: var(--gvx-row-height);
    padding: 0 var(--gvx-space-1);
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row-button:hover {
    background: var(--gvx-hover);
  }
  .row-button:focus-visible,
  button.icon:focus-visible,
  button.link:focus-visible {
    outline: 1px solid var(--gvx-focus);
    outline-offset: -1px;
  }
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    width: 1.2em;
    font-family: var(--gvx-font-mono);
    font-size: 0.92em;
    text-align: center;
  }
  .s-A {
    color: var(--gvx-added);
  }
  .s-D {
    color: var(--gvx-removed);
  }
  .s-M,
  .s-R,
  .s-C,
  .s-T {
    color: var(--gvx-modified);
  }
  .counts {
    font-size: 0.92em;
    white-space: nowrap;
  }
  .open-badge {
    font-size: 8px !important;
    color: var(--gvx-focus);
  }
  button.icon,
  button.link {
    border: none;
    background: none;
    color: inherit;
    padding: 2px;
    cursor: pointer;
    border-radius: var(--gvx-radius);
  }
  button.icon:hover {
    background: var(--gvx-hover);
  }
  button.link {
    color: var(--vscode-textLink-foreground, var(--gvx-focus));
  }
</style>
