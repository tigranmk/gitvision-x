<script lang="ts">
  import type { MicroDiff } from '@gvx/protocol';

  let { path, diff, error }: { path: string; diff: MicroDiff | null; error: string | null } = $props();
</script>

<section class="micro-diff" aria-label="Changes in {path}">
  <h4 title={path}>{path}</h4>
  {#if error}
    <p class="muted">{error}</p>
  {:else if !diff}
    <p class="muted">Loading diff…</p>
  {:else if diff.binary}
    <p class="muted">Binary file. Double-click it to open the diff editor.</p>
  {:else if diff.tooLarge}
    <p class="muted">Too large to preview. Double-click it to open the diff editor.</p>
  {:else if !diff.rows.length}
    <p class="muted">No line changes (mode or rename only).</p>
  {:else}
    <table>
      <!-- Fixed layout takes widths from the first row, which may be a gap: set them here. -->
      <colgroup><col class="num-col" /><col /><col class="num-col" /><col /></colgroup>
      <tbody>
        {#each diff.rows as row, i (i)}
          {#if row.kind === 'gap'}
            <tr class="gap"><td colspan="4">⋯</td></tr>
          {:else}
            <tr class={row.kind}>
              <td class="num">{row.left?.line ?? ''}</td>
              <td class="code left" class:empty={!row.left}>{row.left?.text ?? ''}</td>
              <td class="num">{row.right?.line ?? ''}</td>
              <td class="code right" class:empty={!row.right}>{row.right?.text ?? ''}</td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
    {#if diff.truncated}<p class="muted">More changes below. Double-click the file for the full diff.</p>{/if}
  {/if}
</section>

<style>
  .micro-diff {
    border-top: 1px solid var(--gvx-border);
    padding-top: var(--gvx-space-2);
  }
  h4 {
    margin: 0 0 var(--gvx-space-1);
    font-size: 0.92em;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  table {
    width: 100%;
    table-layout: fixed;
    border-collapse: collapse;
    font-family: var(--gvx-font-mono);
    font-size: 0.92em;
  }
  td {
    padding: 0 var(--gvx-space-1);
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 18px;
  }
  .num-col {
    width: 3.5em;
  }
  .num {
    text-align: right;
    color: var(--gvx-text-muted);
    user-select: none;
  }
  tr.del .left,
  tr.mod .left {
    background: var(--gvx-removed-bg);
  }
  tr.add .right,
  tr.mod .right {
    background: var(--gvx-added-bg);
  }
  .empty {
    background: repeating-linear-gradient(-45deg, transparent 0 4px, var(--gvx-border) 4px 5px);
  }
  tr.gap td {
    color: var(--gvx-text-muted);
    text-align: center;
  }
  .muted {
    color: var(--gvx-text-muted);
  }
</style>
