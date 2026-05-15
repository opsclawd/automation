import { describe, expect, it } from 'vitest';
import { packageName } from '../index.js';

describe('@ai-sdlc/infrastructure', () => {
  it('exports a package name', () => {
    expect(packageName).toBe('@ai-sdlc/infrastructure');
  });
});