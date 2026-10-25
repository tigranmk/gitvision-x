<script lang="ts">
  import { onMount } from 'svelte';
  import { relativeTime, type GraphState } from '@gvx/protocol';
  import { readTheme, watchTheme, type CanvasTheme } from '@gvx/ui-tokens';
  import { graphWidth, ROW_HEIGHT } from './draw';
  import { createRenderer, type GraphRenderer } from './renderer';
  import { PageCache } from './pageCache';
  import type { HostRpc } from './rpc';

  let { rpc }: { rpc: HostRpc } = $props();

  let graph = $state<GraphState>({ root: null, total: 0, userEmail: null });
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
    const off = rpc.on('graph.reset', apply);
    rpc.request('graph.state', {}).then(apply, (e) => (error = (e as Error).message));
    const ro = new ResizeObserver(() => (viewHeight = scroller.clientHeight));
    ro.observe(scroller);
    return () => {
      unwatch();
      off();
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
      headRow: -1,
      pulseRow: -1,
      pulse: 1,
      pulseColor: theme.lineSync,
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
            style:transform="translateY({(r - first) * ROW_HEIGHT}px)"
            data-sha={row?.commit.sha}
          >
            <span class="lanes" style:width="{graphW}px"></span>
            {#if row}
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

<style>
  .graph {
    position: relative;
    height: 100vh;
    overflow: hidden;
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
