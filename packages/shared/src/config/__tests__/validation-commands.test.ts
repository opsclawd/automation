import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');

describe('validation commands drift guard (#514)', () => {
  it('validation commands in .ai-orchestrator.json are a superset of CI test steps', () => {
    const config = JSON.parse(
      readFileSync(resolve(REPO_ROOT, '.ai-orchestrator.json'), 'utf-8'),
    ) as { validation: { commands: string[] } };
    const commands = new Set(config.validation.commands);

    const ciYaml = readFileSync(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf-8');

    // CI test steps that must have a corresponding validation command.
    // Each entry is a substring to match against a `run:` line in ci.yml.
    const requiredCiSteps = [
      'pnpm -r build',
      'pnpm lint',
      'pnpm -r typecheck',
      'pnpm test',
      'pnpm test:bash',
      'pnpm depcruise',
    ];

    for (const step of requiredCiSteps) {
      // Verify the step appears in ci.yml
      expect(ciYaml, `CI workflow should contain step: ${step}`).toContain(step);
      // Verify a matching validation command exists
      const hasMatch = [...commands].some((cmd) => {
        const normalize = (s: string) => s.replace('-r ', '');
        return normalize(cmd).includes(normalize(step)) || normalize(step).includes(normalize(cmd));
      });
      expect(
        hasMatch,
        `.ai-orchestrator.json missing validation command for CI step: ${step}`,
      ).toBe(true);
    }
  });
});
