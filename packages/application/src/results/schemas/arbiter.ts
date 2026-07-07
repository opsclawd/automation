import { z } from 'zod';

export const arbiterResultSchema = z.object({
  outcome: z.enum(['finding_invalid', 'finding_valid', 'ambiguous', 'insufficient_evidence']),
  defect_classification: z.string().trim().max(200).optional(),
  evidence: z.string().trim().min(1, 'evidence is required (G1 guardrail)'),
  rationale: z.string().trim().min(1),
});
export type ArbiterResult = z.infer<typeof arbiterResultSchema>;
