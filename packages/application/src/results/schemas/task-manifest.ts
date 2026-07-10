import { z } from 'zod';

export const taskManifestEntryV1Schema = z.object({
  n: z.number().int().min(1, { message: 'manifest task entry must have a valid n (number) and non-empty title (string)' }),
  title: z.string().min(1, { message: 'manifest task entry must have a valid n (number) and non-empty title (string)' }),
  files: z.array(z.string()).optional(),
  validation: z.array(z.string()).optional(),
}).passthrough();

export const taskManifestV1Schema = z.object({
  version: z.literal(1),
  task_count: z.number().int().min(0),
  tasks: z.array(taskManifestEntryV1Schema),
}).passthrough().refine((m) => m.version === 1, {
  message: "manifest version must be 1",
});

export const taskManifestEntryV2Schema = z.object({
  n: z.number().int().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  acceptance_criteria: z.array(z.string()).optional(),
  expected_files: z.array(z.string()).optional(),
  relevant_symbols: z.array(z.string()).optional(),
  design_sections: z.array(z.string()).optional(),
  depends_on: z.array(z.number().int().min(1)).optional(),
  validation_commands: z.array(z.string()).optional(),
  migration_constraints: z.array(z.string()).optional(),
  out_of_scope: z.array(z.string()).optional(),
  // Maintain some compatibility with V1 fields if needed, but the goal is structural
  files: z.array(z.string()).optional(),
  validation: z.array(z.string()).optional(),
}).passthrough();

export const taskManifestV2Schema = z.object({
  version: z.literal(2),
  task_count: z.number().int().min(0),
  tasks: z.array(taskManifestEntryV2Schema),
}).passthrough();

export const taskManifestSchema = z.union([
  taskManifestV1Schema,
  taskManifestV2Schema,
]);

export type TaskManifestEntryV1 = z.infer<typeof taskManifestEntryV1Schema>;
export type TaskManifestV1 = z.infer<typeof taskManifestV1Schema>;
export type TaskManifestEntryV2 = z.infer<typeof taskManifestEntryV2Schema>;
export type TaskManifestV2 = z.infer<typeof taskManifestV2Schema>;
export type TaskManifest = z.infer<typeof taskManifestSchema>;
export type TaskManifestEntry = TaskManifest['tasks'][number];
