<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { LANE_COLORS, relativeTime, type GraphRef, type GraphRefs, type GraphState, type GraphSync, type GraphView } from '@gvx/protocol';
  import Details from './Details.svelte';
  import { readTheme, watchTheme, type CanvasTheme } from '@gvx/ui-tokens';
  import { graphWidth, ROW_HEIGHT } from './draw';
  import { createRenderer, type GraphRenderer } from './renderer';
  import { PageCache } from './pageCache';
  import { vscodeApi, type HostRpc } from './rpc';
  import SearchBar from './SearchBar.svelte';

  let { rpc }: { rpc: HostRpc } = $props();

  type Filter = 'all' | 'branch' | 'file';
  const saved = (vscodeApi.getState() ?? {}) as { filter?: Filter };

  let graph = $state<GraphState>({ root: null, total: 0, userEmail: null, sync: null, activeFile: null });
  /** Which commits are shown; persisted per webview. "file" follows the active editor. */
  let filter = $state<Filter>(saved.filter ?? 'all');
  const view = $derived<GraphView | null>(
    filter === 'all' ? { kind: 'all' } : filter === 'branch' ? { kind: 'branch' } : graph.activeFile ? { kind: 'file', path: graph.activeFile } : null,
  );
  /** Rows in the current view. */
  let total = $state(0);
  let loading = $state(true);

  /** Editor → graph sync (D1): the cursor line's commit, its row in this view, its pulse (0..1), its line lineage. */
  let sync = $state.raw<GraphSync | null>(null);
  let syncRow = $state(-1);
  let pulse = $state(1);
  let lineageShas: string[] = [];
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

  /** `/` search: matching rows of this view, and which one is current. */
  let searching = $state(false);
  let matches = $state.raw<number[]>([]);
  let matchSet = $derived(new Set(matches));
  let matchIndex = $state(-1);
  let searchCapped = $state(false);

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

  // The view a request was made for: pages and lookups for an older view are dropped.
  let viewToken = 0;
  let loadedView = '';
  const cache = new PageCache(
    0,
    (start, count, signal) => rpc.request('graph.page', { root: graph.root!, view: view!, start, count }, { signal }),
    () => {
      lanes = cache.width;
      version++;
    },
    (e) => (error = (e as Error).message),
  );

  /** A shallow clone gets one more row after the last commit: "history truncated", with Fetch more. */
  const boundaryRow = $derived(refs?.shallow && total > 0 ? total : -1);
  const rowCount = $derived(total + (boundaryRow >= 0 ? 1 : 0));
  let fetching = $state(false);
  async function fetchMore() {
    if (!graph.root || fetching) return;
    fetching = true;
    try {
      await rpc.request('graph.fetchMore', { root: graph.root });
    } finally {
      fetching = false;
    }
  }
  const worktreesByRow = $derived.by(() => {
    const m = new Map<number, NonNullable<typeof refs>['worktrees']>();
    for (const w of refs?.worktrees ?? []) if (w.row >= 0) m.set(w.row, [...(m.get(w.row) ?? []), w]);
    return m;
  });
  const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;

  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT)));
  const last = $derived(Math.min(rowCount - 1, Math.floor((scrollTop + viewHeight) / ROW_HEIGHT)));
  const visible = $derived(Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i));
  const graphW = $derived(graphWidth(lanes));

  function apply(next: GraphState) {
    const repoChanged = next.root !== graph.root;
    graph = next;
    error = null;
    if (repoChanged) selected = null;
    sync = next.sync;
    void loadView(repoChanged);
  }

  /** (Re)loads the current view: its size, then pages on demand; re-resolves sync, lineage and refs in it. */
  async function loadView(toTop: boolean) {
    const token = ++viewToken;
    const root = graph.root;
    const v = view;
    loadedView = JSON.stringify([root, v]);
    cache.reset(0);
    total = 0;
    lanes = 1;
    refs = null;
    syncRow = -1;
    lineage = new Int32Array(0);
    matches = [];
    matchIndex = -1;
    version++;
    if (toTop && scroller) scroller.scrollTop = scrollTop = 0;
    if (toTop) activeRow = 0;
    if (!root || !v) {
      loading = false;
      return;
    }
    loading = true;
    try {
      const head = await rpc.request('graph.page', { root, view: v, start: 0, count: 0 });
      if (token !== viewToken) return;
      total = head.total;
      cache.reset(head.total);
      version++;
    } catch (e) {
      if (token === viewToken) error = (e as Error).message;
      return;
    } finally {
      if (token === viewToken) loading = false;
    }
    void loadRefs(token);
    if (sync) void resolveSync(sync, token, false);
    if (searching && query) void runSearch(query);
  }

  async function loadRefs(token = viewToken) {
    const r = await rpc.request('graph.refs', { root: graph.root!, view: view! }).catch(() => null);
    if (token === viewToken && r) refs = r;
  }

  /** Rows of commits in the current view (-1 when filtered out). */
  async function rowsOf(shas: string[], token: number): Promise<number[] | null> {
    if (!graph.root || !view || !shas.length) return shas.length ? null : [];
    const rows = await rpc.request('graph.rows', { root: graph.root, view, shas }).catch(() => null);
    return token === viewToken ? rows : null;
  }

  function setFilter(f: Filter) {
    if (f === filter) return;
    filter = f;
    vscodeApi.setState({ filter: f });
  }

  // Reload when the view changes (filter, or the active file under the file filter).
  $effect(() => {
    const key = JSON.stringify([graph.root, view]);
    if (key !== loadedView) void loadView(true);
  });

  function scrollToRow(row: number) {
    if (row >= first && row <= last - 1) return;
    scroller.scrollTop = scrollTop = Math.max(0, row * ROW_HEIGHT - viewHeight / 2 + ROW_HEIGHT / 2);
  }

  async function jumpTo(sha: string) {
    const [row] = (await rowsOf([sha], viewToken)) ?? [];
    if (row === undefined || row < 0) return;
    selected = sha;
    scrollToRow(row);
  }

  function applySync(next: GraphSync | null) {
    if (next?.seq === sync?.seq) return;
    sync = next;
    syncRow = -1;
    lineage = new Int32Array(0);
    lineageShas = [];
    if (next) void resolveSync(next, viewToken, true);
  }

  async function resolveSync(s: GraphSync, token: number, pulseIt: boolean) {
    const [row] = (await rowsOf([s.sha], token)) ?? [-1];
    if (token !== viewToken || sync?.seq !== s.seq) return;
    syncRow = row ?? -1;
    if (lineageShas.length) void resolveLineage(s.seq, token);
    if (syncRow < 0) return; // filtered out of this view
    // Scroll the commit into view (centred) only when it is outside the viewport.
    if (scroller) scrollToRow(syncRow);
    if (pulseIt) startPulse();
  }

  async function resolveLineage(seq: number, token: number) {
    const rows = await rowsOf(lineageShas, token);
    if (rows && seq === sync?.seq) lineage = Int32Array.from(rows.filter((r) => r >= 0)).sort();
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
    const step = (t: number) => {
      pulse = Math.min(1, (t - start) / (ms * 2));
      if (pulse < 1) pulseFrame = requestAnimationFrame(step);
    };
    pulse = 0;
    pulseFrame = requestAnimationFrame(step);
  }

  // ---- search ----
  let query = '';
  let searchToken = 0;
  async function runSearch(q: string) {
    query = q;
    const token = ++searchToken;
    if (!q.trim() || !graph.root || !view) {
      matches = [];
      matchIndex = -1;
      return;
    }
    const r = await rpc.request('graph.search', { root: graph.root, view, query: q }).catch(() => null);
    if (token !== searchToken || !r) return;
    matches = r.rows;
    searchCapped = r.capped;
    // Start at the first match at or below the top of the viewport.
    const at = r.rows.findIndex((row) => row >= first);
    matchIndex = r.rows.length ? (at >= 0 ? at : 0) : -1;
    if (matchIndex >= 0) goToMatch(matchIndex);
  }

  function goToMatch(i: number) {
    if (!matches.length) return;
    matchIndex = (i + matches.length) % matches.length;
    const row = matches[matchIndex]!;
    scrollToRow(row);
    const sha = cache.row(row)?.commit.sha;
    if (sha) selected = sha;
    else void selectWhenLoaded(row);
  }

  async function selectWhenLoaded(row: number) {
    for (let i = 0; i < 20 && !cache.row(row); i++) await new Promise((r) => setTimeout(r, 25));
    const sha = cache.row(row)?.commit.sha;
    if (sha && matches[matchIndex] === row) selected = sha;
  }

  function closeSearch() {
    searching = false;
    matches = [];
    matchIndex = -1;
    query = '';
    void tick().then(() => listbox?.focus());
  }

  let listbox: HTMLDivElement;
  function onKeydown(e: KeyboardEvent) {
    const typing = (e.target as HTMLElement).closest('input, select, textarea');
    if (e.key === '/' && !typing) {
      e.preventDefault();
      searching = true;
    }
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
      rpc.on('graph.select', (sel) => {
        if (sel.root === graph.root) void jumpTo(sel.sha);
      }),
      rpc.on('graph.activeFile', (a) => {
        if (a.root === graph.root) graph = { ...graph, activeFile: a.path };
      }),
      rpc.on('graph.refresh', (r) => {
        if (r.root !== graph.root) return;
        // A checkout moves HEAD without changing the index: the branch view changes; refs always may.
        if (filter === 'branch') void loadView(false);
        else void loadRefs();
      }),
      rpc.on('graph.lineage', (l) => {
        if (l.seq !== sync?.seq) return;
        lineageShas = l.shas;
        void resolveLineage(l.seq, viewToken);
      }),
    ];
    rpc.request('graph.state', {}).then(apply, (e) => (error = (e as Error).message));
    const ro = new ResizeObserver(() => (viewHeight = scroller.clientHeight));
    ro.observe(scroller);
    window.addEventListener('keydown', onKeydown);
    return () => {
      unwatch();
      offs.forEach((off) => off());
      cancelAnimationFrame(pulseFrame);
      ro.disconnect();
      window.removeEventListener('keydown', onKeydown);
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
      rows: visible.map((r) => (r < total ? (cache.row(r)?.graph ?? null) : null)),
      theme: { lanes: theme.lanes, surface: theme.surface, contrastBorder: theme.contrastBorder, head: theme.head },
      headRow: refs?.head.row ?? -1,
      pulseRow: syncRow,
      pulse,
      pulseColor: theme.lineSync,
      lineage,
      lineageColor: theme.focus,
    });
  });

  /** `v` is the cache version, passed so the template re-reads rows when a page arrives. */
  const rowAt = (r: number, v: number) => (v >= 0 ? cache.row(r) : null);

  function select(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[role=option]');
    if (el?.dataset.row) activeRow = Number(el.dataset.row);
    if (el?.dataset.sha) selected = el.dataset.sha;
  }

  // ---- keyboard (spec: ↑/↓, Enter opens, Space selects; aria-activedescendant on the virtual listbox) ----
  /** The row keyboard focus is on; it is always kept rendered (scrolled into view) so its id resolves. */
  let activeRow = $state(0);
  const pageRows = $derived(Math.max(1, Math.floor(viewHeight / ROW_HEIGHT) - 1));
  function moveTo(row: number) {
    activeRow = Math.max(0, Math.min(rowCount - 1, row));
    // Minimal scroll: just enough to show the row.
    const top = activeRow * ROW_HEIGHT;
    if (top < scroller.scrollTop) scroller.scrollTop = scrollTop = top;
    else if (top + ROW_HEIGHT > scroller.scrollTop + viewHeight) scroller.scrollTop = scrollTop = top + ROW_HEIGHT - viewHeight;
  }
  function onListKeydown(e: KeyboardEvent) {
    const sha = cache.row(activeRow)?.commit.sha;
    switch (e.key) {
      case 'ArrowDown':
        moveTo(activeRow + 1);
        break;
      case 'ArrowUp':
        moveTo(activeRow - 1);
        break;
      case 'PageDown':
        moveTo(activeRow + pageRows);
        break;
      case 'PageUp':
        moveTo(activeRow - pageRows);
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(rowCount - 1);
        break;
      case ' ':
        if (sha) selected = sha;
        break;
      case 'Enter':
        if (activeRow === boundaryRow) void fetchMore();
        else if (sha && graph.root) void rpc.request('graph.openCommit', { root: graph.root, sha });
        break;
      case 'Escape':
        if (!selected) return;
        selected = null;
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  /** What VS Code passes to the commit context menu's commands (webview/context in package.json). */
  const menuContext = (c: { sha: string; subject: string; parents: number }) =>
    JSON.stringify({ webviewSection: 'commit', root: graph.root, sha: c.sha, subject: c.subject, parents: c.parents, preventDefaultContextMenuItems: true });

  // ---- drag a branch chip onto another: merge or rebase (the host asks which, and confirms) ----
  const REF_MIME = 'application/x-gitvision-ref';
  type DragRef = { name: string; kind: 'branch' | 'remote' };
  let dragging: DragRef | null = null;
  let dropTarget = $state<string | null>(null);
  const refAt = (e: Event): DragRef | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.ref[data-ref-name]');
    return el ? { name: el.dataset.refName!, kind: el.dataset.refKind as DragRef['kind'] } : null;
  };
  function ondragstart(e: DragEvent) {
    dragging = refAt(e);
    if (!dragging || !e.dataTransfer) return;
    e.dataTransfer.setData(REF_MIME, JSON.stringify(dragging));
    e.dataTransfer.effectAllowed = 'move';
  }
  function ondragover(e: DragEvent) {
    const target = refAt(e);
    if (!dragging || !target || target.name === dragging.name) {
      dropTarget = null;
      return;
    }
    e.preventDefault();
    dropTarget = target.name;
  }
  function ondrop(e: DragEvent) {
    const target = refAt(e);
    const source = dragging;
    dragging = null;
    dropTarget = null;
    if (!source || !target || target.name === source.name || !graph.root) return;
    e.preventDefault();
    void rpc.request('graph.dropBranch', { root: graph.root, source, target });
  }
  function ondragend() {
    dragging = null;
    dropTarget = null;
  }

  const shortSha = (sha: string) => sha.slice(0, 7);
  const who = (name: string, mail: string) =>
    graph.userEmail && mail.toLowerCase() === graph.userEmail.toLowerCase() ? 'You' : name;
</script>

<div class="graph" data-renderer={renderer?.kind}>
 <div class="list">
  <div class="toolbar">
    <label class="filter">
      <span class="visually-hidden">Show</span>
      <select value={filter} onchange={(e) => setFilter((e.currentTarget as HTMLSelectElement).value as Filter)} aria-label="Commits shown">
        <option value="all">All branches</option>
        <option value="branch">Current branch</option>
        <option value="file">Active file</option>
      </select>
    </label>
    {#if filter === 'file' && graph.activeFile}<span class="scope" title={graph.activeFile}>{graph.activeFile}</span>{/if}
    <span class="spacer"></span>
    {#if searching}
      <SearchBar
        count={matches.length}
        index={matchIndex}
        capped={searchCapped}
        onQuery={(q) => void runSearch(q)}
        onNext={() => goToMatch(matchIndex + 1)}
        onPrev={() => goToMatch(matchIndex - 1)}
        onClose={closeSearch}
      />
    {:else}
      <button class="icon" title="Search (/)" aria-label="Search commits" onclick={() => (searching = true)}><i class="codicon codicon-search"></i></button>
    {/if}
  </div>
  {#if error}
    <p class="message">{error}</p>
  {:else if !graph.root}
    <p class="message">No git repository is open.</p>
  {:else if filter === 'file' && !graph.activeFile}
    <p class="message">Open a file of this repository to see the commits that touched it.</p>
  {:else if loading}
    <p class="message">Loading history…</p>
  {:else if total === 0}
    <p class="message">No commits{filter === 'file' ? ' touch this file' : ''}.</p>
  {/if}
  <div class="scroller" bind:this={scroller} onscroll={() => (scrollTop = scroller.scrollTop)}>
    <div class="viewport" style:height="{viewHeight}px">
      <canvas bind:this={canvas} style:width="{graphW}px" style:height="{viewHeight}px"></canvas>
      <!-- Keyboard is on the listbox (↑/↓, PageUp/PageDown, Home/End, Enter, Space, Escape): rows need no handlers. -->
      <div
        class="rows"
        role="listbox"
        aria-label="Commits"
        tabindex="0"
        bind:this={listbox}
        aria-activedescendant={activeRow < rowCount ? `row-${activeRow}` : undefined}
        onkeydown={onListKeydown}
        onclick={select}
        oncontextmenu={select}
        {ondragstart}
        {ondragover}
        {ondrop}
        {ondragend} style:transform="translateY({-(scrollTop % ROW_HEIGHT)}px)">
        {#each visible as r (r)}
          {#if r === boundaryRow}
            <div class="row boundary" class:active={r === activeRow} role="option" tabindex="-1" id="row-{r}" data-row={r} aria-selected="false" style:transform="translateY({(r - first) * ROW_HEIGHT}px)">
              <span class="lanes" style:width="{graphW}px"></span>
              <i class="codicon codicon-fold-down"></i>
              <span class="subject">History truncated (shallow clone)</span>
              <button class="fetch-more" disabled={fetching} onclick={(e) => { e.stopPropagation(); void fetchMore(); }}>
                {fetching ? 'Fetching…' : 'Fetch more'}
              </button>
            </div>
          {:else}
          {@const row = rowAt(r, version)}
          <div
            class="row"
            role="option"
            tabindex="-1"
            id="row-{r}"
            aria-selected={!!row && row.commit.sha === selected}
            class:selected={!!row && row.commit.sha === selected}
            class:synced={r === syncRow}
            class:match={matchSet.has(r)}
            style:transform="translateY({(r - first) * ROW_HEIGHT}px)"
            data-sha={row?.commit.sha}
            data-row={r}
            class:active={r === activeRow}
            data-vscode-context={row ? menuContext(row.commit) : undefined}
          >
            <span class="lanes" style:width="{graphW}px"></span>
            {#if row}
              {#if r === detachedRow}<span class="ref head" title="HEAD is detached at this commit">HEAD</span>{/if}
              {#each refsByRow.get(r) ?? [] as ref (ref.kind + ref.name)}
                <span
                  class="ref {ref.kind}"
                  class:head={isHead(ref)}
                  class:drop-target={dropTarget === ref.name}
                  draggable={ref.kind !== 'tag'}
                  data-ref-name={ref.kind !== 'tag' ? ref.name : undefined}
                  data-ref-kind={ref.kind}
                  title="{ref.kind === 'tag' ? 'Tag' : ref.kind === 'remote' ? 'Remote branch' : isHead(ref) ? 'Current branch (HEAD)' : 'Branch'} {ref.name}"
                  style:--chip-color={theme?.lanes[row.graph.lane % LANE_COLORS]}
                ><i class="codicon codicon-{ref.kind === 'tag' ? 'tag' : ref.kind === 'remote' ? 'cloud' : 'git-branch'}"></i>{ref.name}</span>
              {/each}
              {#each worktreesByRow.get(r) ?? [] as wt (wt.path)}
                <span class="ref worktree" title="Worktree {wt.path}: HEAD {wt.branch ? `on ${wt.branch}` : 'detached'} here"
                  ><i class="codicon codicon-folder"></i>{baseName(wt.path)}{wt.branch ? '' : ' (detached)'}</span>
              {/each}
              <span class="subject">{row.commit.subject}</span>
              <span class="author">{who(row.commit.author, row.commit.authorMail)}</span>
              <span class="date">{relativeTime(row.commit.time, now)}</span>
              <span class="sha">{shortSha(row.commit.sha)}</span>
            {/if}
          </div>
          {/if}
        {/each}
      </div>
    </div>
    <div style:height="{Math.max(0, rowCount * ROW_HEIGHT - viewHeight)}px"></div>
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
    display: flex;
    flex-direction: column;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--gvx-space-2);
    height: 28px;
    padding: 0 var(--gvx-space-2);
    border-bottom: 1px solid var(--gvx-border);
    flex: none;
  }
  .toolbar select {
    background: var(--vscode-dropdown-background, var(--gvx-surface));
    color: var(--vscode-dropdown-foreground, var(--gvx-text));
    border: 1px solid var(--vscode-dropdown-border, var(--gvx-border));
    border-radius: var(--gvx-radius);
    font: inherit;
    padding: 1px 4px;
  }
  .toolbar select:focus-visible,
  .toolbar button:focus-visible {
    outline: 1px solid var(--gvx-focus);
    outline-offset: -1px;
  }
  .scope {
    color: var(--gvx-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .spacer {
    flex: 1;
  }
  .toolbar button.icon {
    border: none;
    background: none;
    color: inherit;
    padding: 2px;
    border-radius: var(--gvx-radius);
    cursor: pointer;
  }
  .toolbar button.icon:hover {
    background: var(--gvx-hover);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
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
    top: 28px;
    left: 0;
    z-index: 2;
    margin: var(--gvx-space-2) var(--gvx-space-3);
    color: var(--gvx-text-muted);
  }
  .scroller {
    flex: 1;
    min-height: 0;
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
  /* Focus shows on the active row (aria-activedescendant), not on the whole list. */
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
  .rows:focus-visible .row.active,
  .rows:focus .row.active {
    outline: 1px solid var(--gvx-focus);
    outline-offset: -1px;
  }
  .row:hover {
    background: var(--gvx-hover);
  }
  .row.boundary {
    color: var(--gvx-text-muted);
    font-style: italic;
  }
  .fetch-more {
    font: inherit;
    font-style: normal;
    color: var(--vscode-button-foreground, var(--gvx-text));
    background: var(--vscode-button-background, var(--gvx-selection));
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: var(--gvx-radius);
    padding: 0 8px;
    cursor: pointer;
  }
  .fetch-more:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground, var(--gvx-selection));
  }
  .fetch-more:focus-visible {
    outline: 1px solid var(--gvx-focus);
    outline-offset: 1px;
  }
  .row.match .subject {
    text-decoration: underline;
    text-decoration-color: var(--gvx-focus);
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
