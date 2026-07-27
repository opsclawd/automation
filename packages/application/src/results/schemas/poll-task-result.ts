import { z } from 'zod';

export const pollTaskResultSchema = z.object({
  commentId: z.number().int(),
  action: z.enum(['fixed', 'no_fix', 'blocked']),
  replyBody: z.string().min(1),
  blockedReason: z.string().optional(),
});

export type PollTaskResult = z.infer<typeof pollTaskResultSchema>;

export const pollTaskBatchResultEntrySchema = z.object({
  commentId: z.number().int().min(0),
  action: z.enum(['fixed', 'no_fix', 'blocked']),
  replyBody: z.string().min(1),
  blockedReason: z.string().optional(),
});

export type PollTaskBatchResultEntry = z.infer<typeof pollTaskBatchResultEntrySchema>;

export const pollTaskBatchResultSchema = z.array(pollTaskBatchResultEntrySchema);

export type PollTaskBatchResult = z.infer<typeof pollTaskBatchResultSchema>;

export interface ValidatePollTaskBatchResultOutput {
  ok: true;
  results: PollTaskBatchResultEntry[];
  missingIds: never;
  duplicateIds: never;
  unknownIds: never;
}

export interface ValidatePollTaskBatchResultError {
  ok: false;
  results: never;
  missingIds: number[];
  duplicateIds: number[];
  unknownIds: number[];
}

export function validatePollTaskBatchResult(
  parsed: unknown,
  expectedCommentIds: readonly number[],
): ValidatePollTaskBatchResultOutput | ValidatePollTaskBatchResultError {
  const parseResult = pollTaskBatchResultSchema.safeParse(parsed);
  if (!parseResult.success) {
    return {
      ok: false,
      results: undefined as never,
      missingIds: [],
      duplicateIds: [],
      unknownIds: [],
    };
  }

  const results = parseResult.data;
  const expectedSet = new Set(expectedCommentIds);
  const resultIds = results.map((r) => r.commentId);
  const resultIdCounts = new Map<number, number>();

  for (const id of resultIds) {
    resultIdCounts.set(id, (resultIdCounts.get(id) ?? 0) + 1);
  }

  const missingIds: number[] = [];
  for (const id of expectedCommentIds) {
    if (!resultIds.includes(id)) {
      missingIds.push(id);
    }
  }

  const duplicateIds: number[] = [];
  for (const [id, count] of resultIdCounts) {
    if (count > 1) {
      duplicateIds.push(id);
    }
  }

  const unknownIds: number[] = [];
  for (const id of resultIds) {
    if (!expectedSet.has(id)) {
      unknownIds.push(id);
    }
  }

  if (missingIds.length > 0 || duplicateIds.length > 0 || unknownIds.length > 0) {
    return { ok: false, results: undefined as never, missingIds, duplicateIds, unknownIds };
  }

  const normalizedResults = expectedCommentIds.map(
    (id) => results.find((r) => r.commentId === id)!,
  );

  return {
    ok: true,
    results: normalizedResults,
    missingIds: undefined!,
    duplicateIds: undefined!,
    unknownIds: undefined!,
  };
}
