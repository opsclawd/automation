/**
 * Bounded Least Recently Used (LRU) Map implementation.
 * Evicts the least recently accessed/inserted entry when capacity is exceeded.
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();
  readonly maxSize: number;

  constructor(maxSize: number = 1000) {
    if (maxSize <= 0) {
      throw new RangeError('maxSize must be greater than 0');
    }
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) {
      return undefined;
    }
    const value = this.map.get(key)!;
    // Refresh recency by re-inserting at the end of the Map iteration order
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, value);
    return this;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }
}
