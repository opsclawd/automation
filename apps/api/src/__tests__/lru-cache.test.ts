import { describe, it, expect } from 'vitest';
import { LruMap } from '../lru-cache.js';

describe('LruMap', () => {
  it('stores and retrieves values', () => {
    const cache = new LruMap<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  it('evicts the least recently used entry when exceeding maxSize', () => {
    const cache = new LruMap<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.size).toBe(3);

    // Adding a 4th entry evicts 'a' (oldest)
    cache.set('d', 4);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
    expect(cache.size).toBe(3);
  });

  it('updates recency on get so accessed entries are not evicted prematurely', () => {
    const cache = new LruMap<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    // Access 'a', making 'b' the oldest
    expect(cache.get('a')).toBe(1);

    // Adding 'd' should now evict 'b' instead of 'a'
    cache.set('d', 4);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('updates recency and value on setting an existing key', () => {
    const cache = new LruMap<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    // Update 'a', making 'b' the oldest
    cache.set('a', 10);

    cache.set('d', 4);
    expect(cache.get('a')).toBe(10);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('supports delete, clear, and has', () => {
    const cache = new LruMap<string, number>(3);
    cache.set('a', 1);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);

    expect(cache.delete('a')).toBe(true);
    expect(cache.has('a')).toBe(false);
    expect(cache.size).toBe(0);

    cache.set('b', 2);
    cache.set('c', 3);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('b')).toBeUndefined();
  });

  it('rejects invalid maxSize', () => {
    expect(() => new LruMap(0)).toThrow(RangeError);
    expect(() => new LruMap(-5)).toThrow(RangeError);
  });
});
