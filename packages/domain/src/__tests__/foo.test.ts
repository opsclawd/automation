import { describe, it, expect } from 'vitest';
import { foo } from '../foo.js';

describe('foo', () => {
  it('returns bar', () => {
    expect(foo()).toBe('bar');
  });
});
