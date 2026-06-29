import { join } from 'path';
import { existsSync } from 'fs';
import { readFile, writeFile, rename } from 'fs/promises';
import type {
  ReviewLoopHistoryPort,
  ReviewLoopHistoryEntry,
  ReviewLoopHistoryAudience,
  StepContext,
  EventBusPort,
} from '@ai-sdlc/application';
import { formatReviewLoopHistoryForPrompt } from '@ai-sdlc/application';

export function createReviewLoopHistoryFilePort(events: EventBusPort): ReviewLoopHistoryPort {
  return {
    async read(ctx: StepContext): Promise<ReviewLoopHistoryEntry[]> {
      const filePath = join(ctx.cwd, 'review-loop-history.json');
      if (!existsSync(filePath)) {
        return [];
      }
      try {
        const content = await readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed)) {
          throw new Error('Parsed JSON is not an array');
        }
        return parsed as ReviewLoopHistoryEntry[];
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        events.publish(ctx.runId as unknown as string, {
          runId: ctx.runId as unknown as string,
          phase: ctx.phaseId as unknown as string,
          level: 'warn',
          type: 'review_loop_history.read_failed',
          message: `Failed to read review loop history: ${errorMsg}`,
          timestamp: new Date().toISOString(),
          metadata: {
            iterationIndex: ctx.iterationIndex,
            error: errorMsg,
          },
        });
        return [];
      }
    },

    async append(ctx: StepContext, entry: ReviewLoopHistoryEntry): Promise<void> {
      const filePath = join(ctx.cwd, 'review-loop-history.json');
      let entries: ReviewLoopHistoryEntry[] = [];

      if (existsSync(filePath)) {
        try {
          const content = await readFile(filePath, 'utf-8');
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            entries = parsed as ReviewLoopHistoryEntry[];
          } else {
            events.publish(ctx.runId as unknown as string, {
              runId: ctx.runId as unknown as string,
              phase: ctx.phaseId as unknown as string,
              level: 'warn',
              type: 'review_loop_history.read_failed',
              message: 'Failed to read review loop history: Parsed JSON is not an array',
              timestamp: new Date().toISOString(),
              metadata: {
                iterationIndex: ctx.iterationIndex,
                error: 'Parsed JSON is not an array',
              },
            });
          }
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          events.publish(ctx.runId as unknown as string, {
            runId: ctx.runId as unknown as string,
            phase: ctx.phaseId as unknown as string,
            level: 'warn',
            type: 'review_loop_history.read_failed',
            message: `Failed to read review loop history: ${errorMsg}`,
            timestamp: new Date().toISOString(),
            metadata: {
              iterationIndex: ctx.iterationIndex,
              error: errorMsg,
            },
          });
        }
      }

      const newEntries = [...entries, entry];
      const tmpPath = join(ctx.cwd, `review-loop-history.json.tmp-${process.pid}-${Date.now()}`);

      await writeFile(tmpPath, JSON.stringify(newEntries, null, 2), 'utf-8');
      await rename(tmpPath, filePath);
    },

    format(history: ReviewLoopHistoryEntry[], audience: ReviewLoopHistoryAudience): string {
      return formatReviewLoopHistoryForPrompt(history, audience);
    },
  };
}
