import { z } from 'zod';
import { taskManifestSchema, type TaskManifest } from './task-manifest.js';

export const plannerPackageSchema = z.object({
  design_md: z.string().trim().min(1, 'design_md must be a non-empty string'),
  plan_md: z.string().trim().min(1, 'plan_md must be a non-empty string'),
  task_manifest: z.union([
    taskManifestSchema,
    z.string().transform((val, ctx) => {
      try {
        const parsed = JSON.parse(val);
        const res = taskManifestSchema.safeParse(parsed);
        if (!res.success) {
          for (const issue of res.error.issues) {
            ctx.addIssue(issue);
          }
          return z.NEVER;
        }
        return res.data;
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `task_manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        });
        return z.NEVER;
      }
    }),
  ]),
  summary: z.string().optional(),
  result: z.enum(['ready', 'blocked']).optional(),
});

export type PlannerPackage = {
  design_md: string;
  plan_md: string;
  task_manifest: TaskManifest;
  summary?: string;
  result?: 'ready' | 'blocked';
};
