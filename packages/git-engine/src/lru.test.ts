import { expect, it } from 'vitest';
import { LruCache } from './lru';

it('evicts least recently used entries by size', () => {
  const c = new LruCache<string, number>(10, (v) => v);
  c.set('a', 4);
  c.set('b', 4);
  c.get('a'); // a is now most recent
  c.set('c', 4); // evicts b
  expect([c.get('a'), c.get('b'), c.get('c')]).toEqual([4, undefined, 4]);
  c.set('huge', 11); // larger than the cache: ignored
  expect(c.get('huge')).toBeUndefined();
});
