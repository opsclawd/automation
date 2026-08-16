import { describe, it, expect } from 'vitest';
import { buildReviewFixReviewPrompt } from '../review-fix-prompts.js';

describe('review-fix prompt branch-created files', () => {
  type InputWithCreatedFiles = Parameters<typeof buildReviewFixReviewPrompt>[0] & {
    createdFiles: string[];
  };

  it('limits branch-created file remedies to modification or deletion without suppressing findings', () => {
    const input: InputWithCreatedFiles = {
      cwd: '/wt',
      repoId: 'owner/repo',
      defaultBranch: 'main',
      createdFiles: ['vitest.integration.config.ts'],
    };
    const prompt = buildReviewFixReviewPrompt(input);

    expect(prompt).toContain('vitest.integration.config.ts');
    expect(prompt).toMatch(/report.*substantive defect/i);
    expect(prompt).toMatch(/modify or delete/i);
    expect(prompt).toMatch(/(?:revert|restore|return).*(?:previous|original)/i);
  });
});
