/** Small LRU on Map insertion order, bounded by an estimated byte size. */
export class LruCache<K, V> {
  private readonly map = new Map<K, { value: V; size: number }>();
  private total = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly sizeOf: (v: V) => number,
  ) {}

  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: K, value: V): void {
    this.delete(key);
    const size = this.sizeOf(value);
    if (size > this.maxBytes) return;
    this.map.set(key, { value, size });
    this.total += size;
    for (const [k, e] of this.map) {
      if (this.total <= this.maxBytes) break;
      this.map.delete(k);
      this.total -= e.size;
    }
  }

  delete(key: K): void {
    const e = this.map.get(key);
    if (e) {
      this.map.delete(key);
      this.total -= e.size;
    }
  }

  get size(): number {
    return this.map.size;
  }
}
