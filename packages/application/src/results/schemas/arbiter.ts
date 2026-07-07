import { z } from 'zod';

export const arbiterResultSchema = z.object({
  outcome: z.enum([
    'finding_valid',
    'finding_invalid',
    'ambiguous',
    'insufficient_evidence',
  ]),
  defect_classification: z.string().optional(),
  evidence: z.string().min(1),
  rationale: z.string().min(1),
});

export type ArbiterResult = z.infer<typeof arbiterResultSchema>;
