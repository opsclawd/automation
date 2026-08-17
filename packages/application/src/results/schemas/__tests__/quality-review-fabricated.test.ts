import { describe, expect, it } from 'vitest';
import { qualityReviewResultSchema } from '../quality-review.js';
import { PHASE_RESULT_REGISTRY } from '../../phase-registry.js';

describe('quality-review fabricated schema contract', () => {
  it('accepts fabricated as a quality-review result and advertises it in the phase contract', () => {
    const payload = {
      result: 'fabricated',
      findings: [
        {
          severity: 'P0',
          summary: 'The claimed hardware telemetry has no physical execution provenance',
          file: 'certification/transition-soak/result.json',
        },
      ],
    };
    expect(
      (
        qualityReviewResultSchema.parse(
          payload as unknown as Parameters<typeof qualityReviewResultSchema.parse>[0],
        ) as unknown as { result: string }
      ).result,
    ).toBe('fabricated');
    expect(PHASE_RESULT_REGISTRY['quality-review']?.schemaContractText).toContain(
      '"pass" | "fail" | "fabricated"',
    );
  });
});
