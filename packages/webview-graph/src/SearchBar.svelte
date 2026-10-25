<script lang="ts">
  import { onMount } from 'svelte';

  let {
    count,
    index,
    capped,
    onQuery,
    onNext,
    onPrev,
    onClose,
  }: {
    count: number;
    index: number;
    capped: boolean;
    onQuery: (q: string) => void;
    onNext: () => void;
    onPrev: () => void;
    onClose: () => void;
  } = $props();

  let input: HTMLInputElement;
  let value = $state('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Debounce typing; Enter searches at once. */
  const DEBOUNCE_MS = 150;

  onMount(() => input.focus());

  function oninput() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onQuery(value);
    }, DEBOUNCE_MS);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
        onQuery(value);
      } else if (e.shiftKey) onPrev();
      else onNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }
</script>

<div class="search" role="search">
  <input
    bind:this={input}
    bind:value
    {oninput}
    {onkeydown}
    type="text"
    placeholder="Message, author, SHA · path:src/x.ts"
    aria-label="Search commits by message, author or SHA; path: for files"
  />
  <span class="count" aria-live="polite">
    {#if value.trim()}{count ? `${index + 1} of ${count}${capped ? '+' : ''}` : 'No results'}{/if}
  </span>
  <button title="Previous (Shift+Enter)" aria-label="Previous match" disabled={!count} onclick={onPrev}><i class="codicon codicon-arrow-up"></i></button>
  <button title="Next (Enter)" aria-label="Next match" disabled={!count} onclick={onNext}><i class="codicon codicon-arrow-down"></i></button>
  <button title="Close (Escape)" aria-label="Close search" onclick={onClose}><i class="codicon codicon-close"></i></button>
</div>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  input {
    width: 220px;
    background: var(--vscode-input-background, var(--gvx-surface));
    color: var(--vscode-input-foreground, var(--gvx-text));
    border: 1px solid var(--vscode-input-border, var(--gvx-border));
    border-radius: var(--gvx-radius);
    font: inherit;
    padding: 1px 4px;
  }
  input:focus {
    outline: 1px solid var(--gvx-focus);
    outline-offset: -1px;
  }
  .count {
    min-width: 5em;
    color: var(--gvx-text-muted);
    font-size: 0.92em;
    text-align: right;
  }
  button {
    border: none;
    background: none;
    color: inherit;
    padding: 2px;
    border-radius: var(--gvx-radius);
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--gvx-hover);
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  button:focus-visible {
    outline: 1px solid var(--gvx-focus);
    outline-offset: -1px;
  }
</style>
