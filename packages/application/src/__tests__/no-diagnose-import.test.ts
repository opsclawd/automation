import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

describe('diagnose-result.ts is not imported by production code', () => {
  it('no production module imports diagnose-result', () => {
    const result = execSync(
      'rg -l "diagnose-result" --glob "!**/node_modules/**" --glob "!*.result" --glob "!*.log" packages/ apps/ || true',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    const files = result ? result.split('\n').filter(Boolean) : [];
    const forbidden = files.filter(
      (f) => !f.includes('no-diagnose-import.test') && !f.endsWith('diagnose-result.ts'),
    );
    expect(forbidden).toEqual([]);
  });
});
