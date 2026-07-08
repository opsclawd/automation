import { join } from 'path';
import { existsSync } from 'fs';
import { readFile, writeFile, rename } from 'fs/promises';
import type {
  ImplementStepHistoryPort,
  ImplementStepHistoryEntry,
  StepLoopContext,
  EventBusPort,
} from '@ai-sdlc/application';
import { formatImplementStepHistoryForPrompt } from '@ai-sdlc/application';

export function createImplementStepHistoryFilePort(events: EventBusPort): ImplementStepHistoryPort {
  const filePathFor = (ctx: StepLoopContext): string =>
    join(ctx.cwd, `implement-step-history-${ctx.stepIndex}.json`);

  const warn = (ctx: StepLoopContext, type: string, error: string): void => {
    events.publish(String(ctx.runId), {
      runId: String(ctx.runId),
      phase: String(ctx.phaseId),
      level: 'warn',
      type,
      message: `Failed to read/write implement-step history: ${error}`,
      timestamp: new Date().toISOString(),
      metadata: { stepIndex: ctx.stepIndex, error },
    });
  };

  return {
    async read(ctx: StepLoopContext): Promise<ImplementStepHistoryEntry[]> {
      const filePath = filePathFor(ctx);
      if (!existsSync(filePath)) return [];
      try {
        const content = await readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed)) throw new Error('Parsed JSON is not an array');
        return parsed as ImplementStepHistoryEntry[];
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(ctx, 'implement_step_history.read_failed', msg);
        return [];
      }
    },

    async append(ctx: StepLoopContext, entry: ImplementStepHistoryEntry): Promise<void> {
      const filePath = filePathFor(ctx);
      let entries: ImplementStepHistoryEntry[] = [];
      if (existsSync(filePath)) {
        try {
          const content = await readFile(filePath, 'utf-8');
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            entries = parsed as ImplementStepHistoryEntry[];
          } else {
            warn(ctx, 'implement_step_history.read_failed', 'Parsed JSON is not an array');
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          warn(ctx, 'implement_step_history.read_failed', msg);
        }
      }
      const newEntries = [...entries, entry];
      const tmpPath = join(
        ctx.cwd,
        `implement-step-history-${ctx.stepIndex}.json.tmp-${process.pid}-${Date.now()}`,
      );
      await writeFile(tmpPath, JSON.stringify(newEntries, null, 2), 'utf-8');
      await rename(tmpPath, filePath);
    },

    format(history: ImplementStepHistoryEntry[]): string {
      return formatImplementStepHistoryForPrompt(history);
    },
  };
}
