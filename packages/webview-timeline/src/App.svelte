<script lang="ts">
  import { onMount } from 'svelte';
  import { relativeTime, type EventMap, type NoMethods, type RpcEndpoint, type TimelineHostEvents, type TimelineHostMethods, type TimelinePosition, type TimelineRevisions } from '@gvx/protocol';
  import { buildTicks, tickOf, BUCKET_ABOVE } from './ticks';

  let { rpc }: { rpc: RpcEndpoint<NoMethods, TimelineHostMethods, EventMap, TimelineHostEvents> } = $props();

  let pos = $state.raw<TimelinePosition>({ active: false, file: null, index: -1, pinned: null, loading: null, session: 0 });
  let revs = $state.raw<TimelineRevisions | null>(null);
  /** Index the thumb shows while dragging, before the host confirms the step. */
  let dragIndex = $state<number | null>(null);
  let error = $state<string | null>(null);
  const now = Math.floor(Date.now() / 1000);

  const ticks = $derived(revs ? buildTicks(revs.revisions) : []);
  const bucketed = $derived((revs?.revisions.length ?? 0) > BUCKET_ABOVE);
  const shownIndex = $derived(dragIndex ?? pos.index);
  const thumbTick = $derived(tickOf(ticks, shownIndex));
  const current = $derived(shownIndex >= 0 ? revs?.revisions[shownIndex] : undefined);
  /** Ticks plus the "Now" slot at the right end. */
  const slots = $derived(ticks.length + 1);
  const x = (slot: number) => `${((slot + 0.5) / slots) * 100}%`;
  const fileName = (p: string | null) => (p ? p.split('/').pop()! : '');

  async function apply(p: TimelinePosition) {
    pos = p;
    if (!p.active) {
      revs = null;
      return;
    }
    if (revs?.session !== p.session) {
      const r = await rpc.request('timeline.revisions', {});
      if (r && r.session === pos.session) revs = r;
    }
    if (dragIndex === p.index) dragIndex = null;
  }

  onMount(() => {
    const off = rpc.on('timeline.position', (p) => void apply(p));
    rpc.request('timeline.position', {}).then(apply, (e) => (error = (e as Error).message));
    return off;
  });

  function go(index: number) {
    if (!revs) return;
    index = Math.max(-1, Math.min(revs.revisions.length - 1, index));
    dragIndex = index;
    void rpc.request('timeline.go', { session: pos.session, index });
  }

  /** Slot → revision index: "Now" is the working copy; a tick shows its (newest) revision. */
  const indexOfSlot = (slot: number) => (slot >= ticks.length ? -1 : ticks[Math.max(0, slot)]!.index);

  // ---- dragging the thumb (pointer anywhere on the track) ----
  // Bound inside {#if}: state, so Svelte tracks it as the block mounts and unmounts.
  let track = $state<HTMLDivElement>();
  let dragging = false;
  function slotAt(clientX: number) {
    const r = track!.getBoundingClientRect();
    return Math.max(0, Math.min(slots - 1, Math.floor(((clientX - r.left) / r.width) * slots)));
  }
  function onpointerdown(e: PointerEvent) {
    if (!pos.active) return;
    dragging = true;
    track?.setPointerCapture(e.pointerId);
    move(e);
  }
  function move(e: PointerEvent) {
    if (!dragging) return;
    const index = indexOfSlot(slotAt(e.clientX));
    if (index !== shownIndex) go(index);
  }
  function onpointerup(e: PointerEvent) {
    dragging = false;
    track?.releasePointerCapture(e.pointerId);
  }

  function onkeydown(e: KeyboardEvent) {
    if (!revs) return;
    const n = revs.revisions.length;
    // Left = back in time (older = higher index); the working copy is right of the newest revision.
    const step = (d: number) => {
      e.preventDefault();
      const slot = Math.max(0, Math.min(slots - 1, thumbTick + d));
      go(indexOfSlot(slot));
    };
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'PageUp') step(-10);
    else if (e.key === 'PageDown') step(10);
    else if (e.key === 'Home') step(-n);
    else if (e.key === 'End') step(n);
  }

  const tickTitle = (i: number) => {
    const t = ticks[i]!;
    const r = revs!.revisions[t.index]!;
    const count = t.last - t.first + 1;
    const head = count > 1 ? `${count} revisions, week of ${new Date(revs!.revisions[t.last]!.time * 1000).toLocaleDateString()}; newest:\n` : '';
    return `${head}${r.sha.slice(0, 7)} ${r.subject}\n${r.author}, ${relativeTime(r.time, now)}${r.path !== revs!.path ? `\nwas ${r.path}` : ''}`;
  };
  const valueText = $derived(current ? `${current.subject}, ${relativeTime(current.time, now)}` : 'Working copy');
</script>

<div class="timeline">
  {#if error}
    <p class="muted">{error}</p>
  {:else if !pos.active}
    <div class="idle">
      {#if pos.file}
        <span>Step <strong>{fileName(pos.file)}</strong> back through its history.</span>
        <button class="primary" onclick={() => void rpc.request('timeline.start', {})}>
          <i class="codicon codicon-history"></i> Start time travel
        </button>
        <span class="muted">or <kbd>Alt</kbd>+<kbd>[</kbd> after starting</span>
      {:else}
        <span class="muted">Open a file in a git repository to travel through its history.</span>
      {/if}
    </div>
  {:else}
    <div class="bar">
      <strong class="file" title={pos.file}>{fileName(pos.file)}</strong>
      <span class="where">
        {#if current}
          {revs ? `${revs.revisions.length - shownIndex} of ${revs.revisions.length}` : ''}
        {:else}
          Working copy
        {/if}
      </span>
      <span class="spacer"></span>
      <button class="icon" title="Previous revision (Alt+[)" aria-label="Previous revision" onclick={() => go(shownIndex + 1)}><i class="codicon codicon-arrow-left"></i></button>
      <button class="icon" title="Next revision (Alt+])" aria-label="Next revision" onclick={() => go(shownIndex - 1)}><i class="codicon codicon-arrow-right"></i></button>
      <button
        class="icon"
        class:on={!!pos.pinned}
        title={pos.pinned ? 'Unpin: compare each revision with its predecessor' : 'Pin this revision: compare the next ones against it'}
        aria-label="Pin revision to compare"
        aria-pressed={!!pos.pinned}
        aria-disabled={shownIndex < 0 && !pos.pinned}
        onclick={() => (shownIndex >= 0 || pos.pinned) && void rpc.request('timeline.pin', {})}><i class="codicon codicon-{pos.pinned ? 'pinned' : 'pin'}"></i></button>
      <button class="icon" title="All revisions…" aria-label="All revisions" onclick={() => void rpc.request('timeline.pick', {})}><i class="codicon codicon-list-flat"></i></button>
      <button class="icon" title="Return to working copy (Escape)" aria-label="Return to working copy" onclick={() => void rpc.request('timeline.exit', {})}><i class="codicon codicon-close"></i></button>
    </div>

    <div
      class="track"
      bind:this={track}
      role="slider"
      tabindex="0"
      aria-label="Revision of {fileName(pos.file)}"
      aria-valuemin={0}
      aria-valuemax={slots - 1}
      aria-valuenow={thumbTick}
      aria-valuetext={valueText}
      {onpointerdown}
      onpointermove={move}
      {onpointerup}
      {onkeydown}
    >
      <div class="rail"></div>
      {#each ticks as t, i (t.first)}
        <div class="tick" class:bucket={t.last > t.first} class:pinned={!!pos.pinned && revs?.revisions[t.index]?.sha === pos.pinned} style:left={x(i)} title={tickTitle(i)}></div>
        {#if t.label}<div class="label" style:left={x(i)}>{t.label}</div>{/if}
      {/each}
      <div class="tick now" style:left={x(ticks.length)} title="Working copy"></div>
      <div class="label now-label" style:left={x(ticks.length)}>Now</div>
      <div class="thumb" style:left={x(thumbTick)}>
        {#if pos.loading !== null && pos.loading === shownIndex}<i class="codicon codicon-loading codicon-modifier-spin" aria-label="Loading"></i>{/if}
      </div>
    </div>

    <div class="details" aria-live="polite">
      {#if current}
        <code>{current.sha.slice(0, 7)}</code>
        <span class="subject">{current.subject}</span>
        <span class="muted">{current.author}, {relativeTime(current.time, now)} · {new Date(current.time * 1000).toLocaleDateString()}</span>
        {#if revs && current.path !== revs.path}<span class="muted">· was {current.path}</span>{/if}
        {#if pos.pinned}<span class="muted">· compared with pinned {pos.pinned.slice(0, 7)}</span>{/if}
      {:else}
        <span class="muted">The file as it is now. Drag left, or press <kbd>Alt</kbd>+<kbd>[</kbd>, to go back.</span>
      {/if}
      {#if bucketed}<span class="muted">· {revs!.revisions.length} revisions, one tick per week</span>{/if}
    </div>
  {/if}
</div>

<style>
  .timeline {
    padding: var(--gvx-space-2) var(--gvx-space-3);
    box-sizing: border-box;
  }
  .idle,
  .bar,
  .details {
    display: flex;
    align-items: center;
    gap: var(--gvx-space-2);
    flex-wrap: wrap;
  }
  .file {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .where,
  .muted {
    color: var(--gvx-text-muted);
  }
  .spacer {
    flex: 1;
  }
  button.icon,
  button.primary {
    border: none;
    color: inherit;
    border-radius: var(--gvx-radius);
    cursor: pointer;
    font: inherit;
  }
  button.icon {
    background: none;
    padding: 2px;
  }
  button.icon:hover:not([aria-disabled='true']) {
    background: var(--gvx-hover);
  }
  button.icon.on {
    color: var(--gvx-focus);
  }
  button.icon[aria-disabled='true'] {
    opacity: 0.4;
    cursor: default;
  }
  button.primary {
    background: var(--vscode-button-background, var(--gvx-selection));
    color: var(--vscode-button-foreground, var(--gvx-text));
    padding: 2px 10px;
  }
  button:focus-visible,
  .track:focus-visible {
    outline: 1px solid var(--gvx-focus);
    outline-offset: 1px;
  }
  .track {
    position: relative;
    height: 44px;
    margin: var(--gvx-space-2) 0;
    cursor: pointer;
    touch-action: none;
    user-select: none;
  }
  .rail {
    position: absolute;
    left: 0;
    right: 0;
    top: 14px;
    height: 2px;
    background: var(--gvx-border);
  }
  .tick {
    position: absolute;
    top: 8px;
    width: 2px;
    height: 14px;
    margin-left: -1px;
    background: var(--gvx-text-muted);
    border-radius: 1px;
  }
  .tick.bucket {
    width: 4px;
    margin-left: -2px;
  }
  .tick.now {
    background: var(--gvx-head);
  }
  .tick.pinned {
    background: var(--gvx-focus);
    height: 20px;
    top: 5px;
  }
  .label {
    position: absolute;
    top: 26px;
    transform: translateX(-50%);
    font-size: 0.85em;
    color: var(--gvx-text-muted);
    white-space: nowrap;
  }
  .thumb {
    position: absolute;
    top: 4px;
    width: 12px;
    height: 22px;
    margin-left: -6px;
    border-radius: var(--gvx-radius);
    background: var(--gvx-focus);
    border: 1px solid var(--gvx-contrast-border);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: left var(--gvx-motion);
    pointer-events: none;
  }
  .thumb .codicon {
    font-size: 10px;
    color: var(--vscode-button-foreground, #fff);
  }
  .subject {
    font-weight: 600;
  }
  code {
    font-family: var(--gvx-font-mono);
  }
  kbd {
    font-family: var(--gvx-font-mono);
    font-size: 0.9em;
    border: 1px solid var(--gvx-border);
    border-radius: var(--gvx-radius);
    padding: 0 3px;
  }
</style>
