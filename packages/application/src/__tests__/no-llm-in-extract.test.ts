import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'results', 'extract-result.ts');

describe('extract-result.ts uses AgentPort.invoke exactly once (rerun branch only)', () => {
  it('contains exactly one call to ports.agent.invoke', () => {
    const src = readFileSync(SRC, 'utf-8');
    const matches = src.match(/ports\.agent\.invoke\s*\(/g) ?? [];
    // Exactly one call: the rerun branch. Zero means the rerun was removed;
    // more than one means an additional LLM call was added (layer violation).
    expect(matches.length).toBe(1);
  });
});
