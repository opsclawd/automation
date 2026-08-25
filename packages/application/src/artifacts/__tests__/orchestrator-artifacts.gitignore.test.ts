import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATOR_ARTIFACT_PATHS,
  PROMPT_ORCHESTRATOR_ARTIFACT_PATHS,
  isOrchestratorArtifactPattern,
} from '../orchestrator-artifacts.js';

const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const newlyAddedRootArtifactPatterns = [
  'implementation-log*.md',
  'issue.md',
  'issue-comments.md',
  'plan-review-findings.md',
  'quality-review-result*.json',
  'spec-review-result*.json',
  'fix-result*.json',
  'pr-summary.md',
  'pr-url.txt',
] as const;

function materialize(pattern: string): string {
  return pattern.replaceAll('*', 'probe');
}

describe('repository orchestrator artifact pattern matching', () => {
  it('identifies every declared orchestrator artifact pattern at repository root', () => {
    for (const pattern of [...ORCHESTRATOR_ARTIFACT_PATHS, ...PROMPT_ORCHESTRATOR_ARTIFACT_PATHS]) {
      expect(isOrchestratorArtifactPattern(materialize(pattern)), pattern).toBe(true);
    }
  });

  it('identifies every newly added artifact pattern at repository root', () => {
    for (const pattern of newlyAddedRootArtifactPatterns) {
      expect(isOrchestratorArtifactPattern(materialize(pattern)), pattern).toBe(true);
    }
  });

  it('keeps newly added artifact names visible below packages', () => {
    for (const pattern of newlyAddedRootArtifactPatterns) {
      const nested = join('packages', 'application', materialize(pattern));
      expect(isOrchestratorArtifactPattern(nested), pattern).toBe(false);
    }
  });

  it('tracks no generated review-result or fix-result artifacts', () => {
    const tracked = execFileSync(
      'git',
      [
        'ls-files',
        '--',
        'quality-review-result*.json',
        'spec-review-result*.json',
        'fix-result*.json',
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean);

    expect(tracked).toEqual([]);
  });
});
