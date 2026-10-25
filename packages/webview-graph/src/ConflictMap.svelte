<script lang="ts">
  import type { GraphConflict, GraphConflictFile } from '@gvx/protocol';
  import type { HostRpc } from './rpc';

  let { rpc, root, conflict, onClose }: { rpc: HostRpc; root: string; conflict: GraphConflict; onClose: () => void } = $props();

  const opName = $derived({ merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' }[conflict.op]);
  const title = $derived(
    conflict.op === 'merge'
      ? `Merging ${conflict.theirsLabel} into ${conflict.oursLabel}`
      : conflict.op === 'rebase'
        ? `Rebasing ${conflict.theirsLabel} onto ${conflict.oursLabel}`
        : `${opName} of ${conflict.theirsLabel} onto ${conflict.oursLabel}`,
  );
  const left = $derived(conflict.hunksTotal - conflict.hunksResolved);
  const open = $derived(conflict.files.filter((f) => !f.resolved));
  /** Continue needs every file free of markers (text conflicts get staged on continue) and file-level ones resolved. */
  const canContinue = $derived(open.every((f) => f.total !== null && f.remaining === 0));
  // Progress ring: circumference of r = 18.
  const C = 2 * Math.PI * 18;
  const done = $derived(conflict.hunksTotal ? conflict.hunksResolved / conflict.hunksTotal : 1);

  const act = (path: string, action: 'open' | 'keep' | 'delete' | 'ours' | 'theirs') => void rpc.request('graph.conflictFile', { root, path, action });
  const run = (choice: 'continue' | 'skip' | 'abort') => void rpc.request('graph.conflictRun', { root, choice });

  function describe(f: GraphConflictFile): string {
    if (f.resolved) return 'resolved';
    switch (f.kind) {
      case 'content':
        return f.remaining === 0 ? 'no conflicts left · staged on Continue' : `${f.remaining} of ${f.total} conflict${f.total === 1 ? '' : 's'} left`;
      case 'binary':
        return 'binary: keep one side';
      case 'deleted-by-them':
        return `deleted by ${conflict.theirsLabel}, changed by ${conflict.oursLabel}`;
      case 'deleted-by-us':
        return `deleted by ${conflict.oursLabel}, changed by ${conflict.theirsLabel}`;
      case 'added-by-us':
      case 'added-by-them':
      case 'both-deleted':
        return f.rename ? `renamed differently: ${f.rename.ours} / ${f.rename.theirs}` : 'added on one side only';
    }
  }
  /** Rename/rename shows once, on the original path. */
  const shown = $derived(conflict.files.filter((f) => !(f.rename && f.path !== f.rename.from)));
</script>

<aside class="details conflict-map" aria-label="Conflicts">
  <header>
    <svg class="ring" viewBox="0 0 44 44" role="img" aria-label="{conflict.hunksResolved} of {conflict.hunksTotal} conflicts resolved">
      <circle cx="22" cy="22" r="18" class="track"></circle>
      <circle cx="22" cy="22" r="18" class="done" stroke-dasharray="{C * done} {C}" transform="rotate(-90 22 22)"></circle>
      <text x="22" y="26" text-anchor="middle">{conflict.hunksResolved}/{conflict.hunksTotal}</text>
    </svg>
    <div class="head">
      <h2>{title}</h2>
      <p class="muted">
        {conflict.rebase ? `Step ${conflict.rebase.step} of ${conflict.rebase.total} · ` : ''}{left ? `${left} conflict${left === 1 ? '' : 's'} left` : 'All conflicts resolved'}
      </p>
    </div>
    <button class="icon" title="Close" aria-label="Close" onclick={onClose}><i class="codicon codicon-close"></i></button>
  </header>

  <ul aria-label="Conflicted files">
    {#each shown as f (f.path)}
      <li class:resolved={f.resolved}>
        <button class="file" title="Open {f.path}" aria-label="Open {f.rename ? f.rename.from : f.path}" onclick={() => act(f.path, 'open')}>
          <i class="codicon codicon-{f.resolved ? 'pass' : 'warning'}"></i>
          <span class="name">{f.rename ? f.rename.from : f.path}</span>
        </button>
        <span class="state muted">{describe(f)}</span>
        {#if !f.resolved}
          <span class="card">
            {#if f.kind === 'binary'}
              <button onclick={() => act(f.path, 'ours')}>Keep {conflict.oursLabel}</button>
              <button onclick={() => act(f.path, 'theirs')}>Keep {conflict.theirsLabel}</button>
            {:else if f.rename}
              <button onclick={() => act(f.rename!.ours, 'keep')}>Keep {f.rename.ours}</button>
              <button onclick={() => act(f.rename!.theirs, 'keep')}>Keep {f.rename.theirs}</button>
            {:else if f.kind !== 'content'}
              <button onclick={() => act(f.path, 'keep')}>Keep file</button>
              <button onclick={() => act(f.path, 'delete')}>Delete file</button>
            {/if}
          </span>
        {/if}
      </li>
    {/each}
  </ul>

  <div class="actions">
    <!-- aria-disabled, not disabled: it stays reachable by keyboard and says why it cannot run yet. -->
    <button
      class="primary"
      aria-disabled={!canContinue}
      title={canContinue ? '' : 'Resolve every conflict first'}
      onclick={() => canContinue && run('continue')}
    >
      <i class="codicon codicon-check"></i> {conflict.op === 'merge' ? 'Commit merge' : 'Continue'}
    </button>
    {#if conflict.op !== 'merge'}<button onclick={() => run('skip')}><i class="codicon codicon-debug-step-over"></i> Skip commit</button>{/if}
    <button onclick={() => run('abort')}><i class="codicon codicon-discard"></i> Abort {opName.toLowerCase()}</button>
  </div>
</aside>

<style>
  .conflict-map {
    overflow-y: auto;
    padding: var(--gvx-space-2) var(--gvx-space-3);
    background: var(--gvx-surface);
    border-left: 1px solid var(--gvx-border);
    box-sizing: border-box;
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--gvx-space-3);
  }
  .head {
    flex: 1;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 1.1em;
    font-weight: 600;
  }
  p {
    margin: 2px 0 0;
  }
  .muted {
    color: var(--gvx-text-muted);
  }
  .ring {
    width: 44px;
    height: 44px;
    flex: none;
  }
  .ring circle {
    fill: none;
    stroke-width: 4;
  }
  .ring .track {
    stroke: var(--gvx-border);
  }
  .ring .done {
    stroke: var(--gvx-added);
    transition: stroke-dasharray var(--gvx-motion);
  }
  .ring text {
    fill: var(--gvx-text);
    font-size: 11px;
  }
  ul {
    list-style: none;
    margin: var(--gvx-space-3) 0;
    padding: 0;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px var(--gvx-space-2);
    padding: var(--gvx-space-1) 0;
    border-bottom: 1px solid var(--gvx-border);
  }
  li .codicon-warning {
    color: var(--gvx-conflict);
  }
  li .codicon-pass {
    color: var(--gvx-added);
  }
  li.resolved .name {
    color: var(--gvx-text-muted);
  }
  .file {
    display: flex;
    align-items: center;
    gap: var(--gvx-space-1);
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    padding: 0;
    cursor: pointer;
  }
  .file:hover .name {
    text-decoration: underline;
  }
  .state {
    flex: 1;
    font-size: 0.92em;
  }
  .card,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gvx-space-1);
  }
  .card button,
  .actions button {
    font: inherit;
    border-radius: var(--gvx-radius);
    border: 1px solid var(--vscode-button-border, var(--gvx-border));
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--gvx-text));
    padding: 1px 8px;
    cursor: pointer;
  }
  .actions button.primary {
    background: var(--vscode-button-background, var(--gvx-selection));
    color: var(--vscode-button-foreground, var(--gvx-text));
  }
  button[aria-disabled='true'] {
    opacity: 0.5;
    cursor: default;
  }
  button:focus-visible {
    outline: 1px solid var(--gvx-focus);
    outline-offset: 1px;
  }
  button.icon {
    border: none;
    background: none;
    color: inherit;
    padding: 2px;
    cursor: pointer;
  }
</style>
