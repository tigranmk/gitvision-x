export function debounce(fn: () => void, ms: number): { (): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const d = () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
  d.cancel = () => clearTimeout(timer);
  return d;
}
