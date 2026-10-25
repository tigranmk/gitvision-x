<script lang="ts">
  import { onMount } from 'svelte';
  import { LANE_COLORS, relativeTime, type GraphRef, type GraphRefs, type GraphState, type GraphSync } from '@gvx/protocol';
  import Details from './Details.svelte';
  import { readTheme, watchTheme, type CanvasTheme } from '@gvx/ui-tokens';
  import { graphWidth, ROW_HEIGHT } from './draw';
  import { createRenderer, type GraphRenderer } from './renderer';
  import { PageCache } from './pageCache';
  import type { HostRpc } from './rpc';

  let { rpc }: { rpc: HostRpc } = $props();

  let graph = $state<GraphState>({ root: null, total: 0, userEmail: null, sync: null });
  /** Editor → graph sync (D1): the commit of the cursor line, its pulse (0..1), and the line's lineage. */
  let sync = $state.raw<GraphSync | null>(null);
  let pulse = $state(1);
  let lineage = $state.raw(new Int32Array(0));
  let refs = $state.raw<GraphRefs | null>(null);
  let openFiles = $state.raw<ReadonlySet<string> | null>(null);
  const refsByRow = $derived.by(() => {
    const m = new Map<number, GraphRef[]>();
    for (const r of refs?.refs ?? []) {
      if (r.row < 0) continue;
      const list = m.get(r.row) ?? [];
      list.push(r);
      m.set(r.row, list);
    }
    // HEAD's branch first, then branches, remotes, tags.
    const order = { branch: 0, remote: 1, tag: 2 };
    for (const list of m.values()) list.sort((a, b) => Number(isHead(b)) - Number(isHead(a)) || order[a.kind] - order[b.kind]);
    return m;
  });
  const isHead = (r: GraphRef) => r.kind === 'branch' && r.name === refs?.head.branch;
  /** Detached HEAD: no branch to mark, so the row gets its own HEAD chip. */
  const detachedRow = $derived(refs && !refs.head.branch ? refs.head.row : -1);
  let error = $state<string | null>(null);
  let scrollTop = $state(0);
  let viewHeight = $state(0);
  /** Bumped when a page arrives, so rows and canvas re-read the cache. */
  let version = $state(0);
  let lanes = $state(1);
  let selected = $state<string | null>(null);
  // Raw: replaced whole on theme change, and posted to the render worker (a deep $state proxy cannot be cloned).
  let theme = $state.raw<CanvasTheme | null>(null);

  let scroller: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let renderer = $state<GraphRenderer | null>(null);
  const now = Math.floor(Date.now() / 1000);

  const cache = new PageCache(
    0,
    (start, count, signal) => rpc.request('graph.page', { root: graph.root!, start, count }, { signal }),
    () => {
      lanes = cache.width;
      version++;
    },
    (e) => (error = (e as Error).message),
  );

  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT)));
  const last = $derived(Math.min(graph.total - 1, Math.floor((scrollTop + viewHeight) / ROW_HEIGHT)));
  const visible = $derived(Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i));
  const graphW = $derived(graphWidth(lanes));

  function apply(next: GraphState) {
    const repoChanged = next.root !== graph.root;
    graph = next;
    error = null;
    cache.reset(next.total);
    lanes = 1;
    version++;
    if (repoChanged && scroller) scroller.scrollTop = scrollTop = 0;
    applySync(next.sync);
    refs = null;
    if (next.root) {
      const root = next.root;
      rpc.request('graph.refs', { root }).then(
        (r) => {
          if (graph.root === root) refs = r;
        },
        () => {},
      );
    }
  }

  function scrollToRow(row: number) {
    if (row >= first && row <= last - 1) return;
    scroller.scrollTop = scrollTop = Math.max(0, row * ROW_HEIGHT - viewHeight / 2 + ROW_HEIGHT / 2);
  }

  async function jumpTo(sha: string) {
    const [row] = await rpc.request('graph.rows', { root: graph.root!, shas: [sha] });
    if (row === undefined || row < 0) return;
    selected = sha;
    scrollToRow(row);
  }

  function applySync(next: GraphSync | null) {
    const changed = next?.seq !== sync?.seq;
    sync = next;
    if (!changed) return;
    lineage = new Int32Array(0);
    if (!next || next.row < 0) return;
    // Scroll the commit into view (centred) only when it is outside the viewport.
    if (scroller) scrollToRow(next.row);
    startPulse();
  }

  let pulseFrame = 0;
  function startPulse() {
    cancelAnimationFrame(pulseFrame);
    const ms = theme?.motionMs ?? 0;
    if (ms === 0) {
      pulse = 1; // prefers-reduced-motion: no animation; the row highlight still marks the commit
      return;
    }
    // Two motion lengths: the ring grows and fades out.
    const start = performance.now();
    const tick = (now: number) => {
      pulse = Math.min(1, (now - start) / (ms * 2));
      if (pulse < 1) pulseFrame = requestAnimationFrame(tick);
    };
    pulse = 0;
    pulseFrame = requestAnimationFrame(tick);
  }

  onMount(() => {
    let disposed = false;
    void createRenderer(canvas).then((r) => {
      if (disposed) return r.dispose();
      renderer = r;
      // Dev builds expose the renderer for the webview tests (frame latency, which renderer is live).
      if (__DEV__) (window as unknown as { __gvxRenderer: GraphRenderer }).__gvxRenderer = r;
    });
    theme = readTheme();
    const unwatch = watchTheme((t) => (theme = t));
    const offs = [
      rpc.on('graph.reset', apply),
      rpc.on('graph.sync', applySync),
      rpc.on('graph.openFiles', (o) => {
        if (o.root === graph.root) openFiles = new Set(o.paths);
      }),
      rpc.on('graph.lineage', (l) => {
        if (l.seq === sync?.seq) lineage = Int32Array.from(l.rows).sort();
      }),
    ];
    rpc.request('graph.state', {}).then(apply, (e) => (error = (e as Error).message));
    const ro = new ResizeObserver(() => (viewHeight = scroller.clientHeight));
    ro.observe(scroller);
    return () => {
      unwatch();
      offs.forEach((off) => off());
      cancelAnimationFrame(pulseFrame);
      ro.disconnect();
      disposed = true;
      renderer?.dispose();
    };
  });

  $effect(() => {
    cache.ensure(first, last);
  });

  // Redraw the canvas whenever what it shows changes; runs after the DOM rows update, before paint.
  $effect(() => {
    void version;
    if (!renderer || !theme) return;
    renderer.render({
      width: graphW,
      height: viewHeight,
      dpr: devicePixelRatio || 1,
      scrollTop,
      first,
      rows: visible.map((r) => cache.row(r)?.graph ?? null),
      theme: { lanes: theme.lanes, surface: theme.surface, contrastBorder: theme.contrastBorder, head: theme.head },
      headRow: refs?.head.row ?? -1,
      pulseRow: sync?.row ?? -1,
      pulse,
      pulseColor: theme.lineSync,
      lineage,
      lineageColor: theme.focus,
    });
  });

  /** `v` is the cache version, passed so the template re-reads rows when a page arrives. */
  const rowAt = (r: number, v: number) => (v >= 0 ? cache.row(r) : null);

  function select(e: MouseEvent) {
    const sha = (e.target as HTMLElement).closest<HTMLElement>('[role=option]')?.dataset.sha;
    if (sha) selected = sha;
  }

  const shortSha = (sha: string) => sha.slice(0, 7);
  const who = (name: string, mail: string) =>
    graph.userEmail && mail.toLowerCase() === graph.userEmail.toLowerCase() ? 'You' : name;
</script>

<div class="graph" data-renderer={renderer?.kind}>
 <div class="list">
  {#if error}
    <p class="message">{error}</p>
  {:else if !graph.root}
    <p class="message">No git repository is open.</p>
  {:else if graph.total === 0}
    <p class="message">Loading history…</p>
  {/if}
  <div class="scroller" bind:this={scroller} onscroll={() => (scrollTop = scroller.scrollTop)}>
    <div class="viewport" style:height="{viewHeight}px">
      <canvas bind:this={canvas} style:width="{graphW}px" style:height="{viewHeight}px"></canvas>
      <!-- svelte-ignore a11y_click_events_have_key_events (keyboard navigation is on the listbox: ↑/↓, Enter, Space) -->
      <div class="rows" role="listbox" aria-label="Commits" tabindex="0" onclick={select} style:transform="translateY({-(scrollTop % ROW_HEIGHT)}px)">
        {#each visible as r (r)}
          {@const row = rowAt(r, version)}
          <div
            class="row"
            role="option"
            tabindex="-1"
            id="row-{r}"
            aria-selected={!!row && row.commit.sha === selected}
            class:selected={!!row && row.commit.sha === selected}
            class:synced={r === sync?.row}
            style:transform="translateY({(r - first) * ROW_HEIGHT}px)"
            data-sha={row?.commit.sha}
          >
            <span class="lanes" style:width="{graphW}px"></span>
            {#if row}
              {#if r === detachedRow}<span class="ref head" title="HEAD is detached at this commit">HEAD</span>{/if}
              {#each refsByRow.get(r) ?? [] as ref (ref.kind + ref.name)}
                <span
                  class="ref {ref.kind}"
                  class:head={isHead(ref)}
                  title="{ref.kind === 'tag' ? 'Tag' : ref.kind === 'remote' ? 'Remote branch' : isHead(ref) ? 'Current branch (HEAD)' : 'Branch'} {ref.name}"
                  style:--chip-color={theme?.lanes[row.graph.lane % LANE_COLORS]}
                ><i class="codicon codicon-{ref.kind === 'tag' ? 'tag' : ref.kind === 'remote' ? 'cloud' : 'git-branch'}"></i>{ref.name}</span>
              {/each}
              <span class="subject">{row.commit.subject}</span>
              <span class="author">{who(row.commit.author, row.commit.authorMail)}</span>
              <span class="date">{relativeTime(row.commit.time, now)}</span>
              <span class="sha">{shortSha(row.commit.sha)}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
    <div style:height="{Math.max(0, graph.total * ROW_HEIGHT - viewHeight)}px"></div>
  </div>
 </div>
  {#if selected && graph.root}
    <Details
      {rpc}
      root={graph.root}
      sha={selected}
      refs={refs?.refs.filter((r) => r.sha === selected) ?? []}
      {openFiles}
      userEmail={graph.userEmail}
      onJump={(sha) => void jumpTo(sha)}
      onClose={() => (selected = null)}
    />
  {/if}
</div>

<style>
  .graph {
    display: flex;
    height: 100vh;
    overflow: hidden;
  }
  .list {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  .graph :global(.details) {
    flex: 0 0 40%;
    min-width: 260px;
    max-width: 560px;
  }
  /* Narrow (the panel docked at the side): details below the list. */
  @media (max-width: 640px) {
    .graph {
      flex-direction: column;
    }
    .graph :global(.details) {
      flex: 0 0 45%;
      max-width: none;
      min-width: 0;
      border-left: none;
      border-top: 1px solid var(--gvx-border);
    }
  }
  .message {
    position: absolute;
    inset: 0 auto auto 0;
    margin: var(--gvx-space-2) var(--gvx-space-3);
    color: var(--gvx-text-muted);
  }
  .scroller {
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .viewport {
    position: sticky;
    top: 0;
    overflow: hidden;
  }
  canvas {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    z-index: 1;
  }
  .rows {
    position: absolute;
    inset: 0;
    outline: none;
  }
  .rows:focus-visible {
    outline: 1px solid var(--gvx-focus);
    outline-offset: -1px;
  }
  .row {
    position: absolute;
    left: 0;
    right: 0;
    height: var(--gvx-row-height);
    display: flex;
    align-items: center;
    gap: var(--gvx-space-3);
    padding-right: var(--gvx-space-2);
    white-space: nowrap;
    cursor: default;
  }
  .row:hover {
    background: var(--gvx-hover);
  }
  .row.synced {
    background: var(--gvx-line-sync);
  }
  .row.selected {
    background: var(--gvx-selection);
    color: var(--gvx-selection-text);
  }
  .lanes {
    flex: none;
  }
  .subject {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .author,
  .date,
  .sha {
    flex: none;
    color: var(--gvx-text-muted);
    font-size: 0.92em;
  }
  .author {
    width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .date {
    width: 96px;
  }
  .sha {
    width: 56px;
    font-family: var(--gvx-font-mono);
  }
  .row.selected .author,
  .row.selected .date,
  .row.selected .sha {
    color: inherit;
  }
</style>
