import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ORCHESTRATOR_ARTIFACT_PATHS,
  PROMPT_ORCHESTRATOR_ARTIFACT_PATHS,
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

describe('repository .gitignore artifact reconciliation', () => {
  let isolatedRepository: string;

  beforeAll(() => {
    isolatedRepository = mkdtempSync(join(tmpdir(), 'orchestrator-gitignore-'));
    writeFileSync(
      join(isolatedRepository, '.gitignore'),
      readFileSync(join(repositoryRoot, '.gitignore')),
    );
    execFileSync('git', ['init', '--quiet'], { cwd: isolatedRepository });
  });

  afterAll(() => {
    rmSync(isolatedRepository, { recursive: true, force: true });
  });

  function checkIgnoreStatus(candidate: string): number {
    const result = spawnSync('git', ['check-ignore', '-q', '--no-index', '--', candidate], {
      cwd: isolatedRepository,
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`git check-ignore exited ${result.status}: ${result.stderr}`);
    }
    return result.status;
  }

  it('ignores every declared orchestrator artifact pattern at repository root', () => {
    for (const pattern of [...ORCHESTRATOR_ARTIFACT_PATHS, ...PROMPT_ORCHESTRATOR_ARTIFACT_PATHS]) {
      expect(checkIgnoreStatus(materialize(pattern)), pattern).toBe(0);
    }
  });

  it('ignores every newly added artifact pattern at repository root', () => {
    for (const pattern of newlyAddedRootArtifactPatterns) {
      expect(checkIgnoreStatus(materialize(pattern)), pattern).toBe(0);
    }
  });

  it('keeps newly added artifact names visible below packages', () => {
    for (const pattern of newlyAddedRootArtifactPatterns) {
      const nested = join('packages', 'application', materialize(pattern));
      expect(checkIgnoreStatus(nested), pattern).toBe(1);
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
