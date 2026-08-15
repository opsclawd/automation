import { describe, expect, it } from 'vitest';
import {
  ArtifactNotFoundError,
  type ArtifactStore,
  WORKSPACE_CONSTRAINTS,
} from '@ai-sdlc/application';
import { buildImplementPrompt, buildImplementStepFixPrompt } from '../compose.js';
import { buildReviewFixFixPrompt } from '../review-fix-prompts.js';

const SCRATCH_POLICY = [
  'Transient working files and scratch scripts MUST be written inside `.ai-tmp/`.',
  '`.ai-tmp/` is already gitignored.',
  'Nothing may be written to the worktree root unless it is a declared deliverable.',
] as const;

const missingArtifacts: ArtifactStore = {
  async read(runId, relativePath) {
    throw new ArtifactNotFoundError(runId, relativePath);
  },
  async write() {
    throw new Error('not in scope');
  },
  async list() {
    return [];
  },
  async hydrateWorktree() {},
};

function expectScratchPolicy(prompt: string): void {
  for (const instruction of SCRATCH_POLICY) {
    expect(prompt).toContain(instruction);
  }
}

describe('scratch workspace policy', () => {
  it('states that transient files belong in .ai-tmp and the root is for declared deliverables', () => {
    expectScratchPolicy(WORKSPACE_CONSTRAINTS);
  });

  it('propagates the scratch-file policy to implement prompts', () => {
    const prompt = buildImplementPrompt(
      {
        stepIndex: 1,
        stepTitle: 'Implement the change',
        cwd: '/worktree/issue-894',
        repoId: 'owner/repo',
      },
      'Task context',
      'ai/issue-894',
    );

    expectScratchPolicy(prompt);
  });

  it('propagates the scratch-file policy to fix-validate and review-fix prompts', async () => {
    const validateFixPrompt = await buildImplementStepFixPrompt(missingArtifacts, 'run-1', {
      cwd: '/worktree/issue-894',
      stepIndex: 1,
      stepTitle: 'Implement the change',
    });
    const reviewFixPrompt = buildReviewFixFixPrompt({
      cwd: '/worktree/issue-894',
      repoId: 'owner/repo',
      useFallback: false,
    });

    expectScratchPolicy(validateFixPrompt);
    expectScratchPolicy(reviewFixPrompt);
  });
});
