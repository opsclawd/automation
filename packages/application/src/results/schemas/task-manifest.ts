import { z } from 'zod';

const repositoryRelativePathSchema = z
  .string()
  .min(1, { message: 'declaration_file must be a non-empty repository-relative path' })
  .refine(
    (path) => !path.startsWith('/'), // reject absolute POSIX paths
    { message: 'declaration_file must be a repository-relative path, not absolute' },
  )
  .refine(
    (path) => !path.startsWith('\\'), // reject absolute Windows paths
    { message: 'declaration_file must be a repository-relative path, not absolute' },
  )
  .refine(
    (path) => !path.includes('..'), // reject dot-segment traversal
    { message: 'declaration_file must not contain ".." path segments' },
  )
  .refine(
    (path) => !path.includes('\\'), // reject backslash traversal
    { message: 'declaration_file must use forward slashes, not backslashes' },
  );

export const signatureChangeSchema = z
  .object({
    declaration_file: repositoryRelativePathSchema,
    symbol: z.string().trim().min(1, { message: 'symbol must be a non-empty string' }),
    change: z.enum(['modified', 'not_modified']).optional().default('modified'),
    note: z.string().optional(),
  })
  .strict();

export const taskManifestEntryV1Schema = z
  .object({
    n: z.number().int().min(1, {
      message: 'manifest task entry must have a valid n (number) and non-empty title (string)',
    }),
    title: z.string().min(1, {
      message: 'manifest task entry must have a valid n (number) and non-empty title (string)',
    }),
    files: z.array(z.string()).nullish(),
    validation: z.array(z.string()).nullish(),
  })
  .passthrough();

export const taskManifestV1Schema = z
  .object({
    version: z.literal(1),
    task_count: z.number().int().min(0),
    tasks: z.array(taskManifestEntryV1Schema),
  })
  .passthrough()
  .refine((m) => m.version === 1, {
    message: 'manifest version must be 1',
  });

export const taskManifestEntryV2Schema = z
  .object({
    n: z.number().int().min(1),
    title: z.string().min(1),
    description: z.string().nullish(),
    acceptance_criteria: z.array(z.string()).nullish(),
    expected_files: z.array(z.string()).nullish(),
    relevant_symbols: z.array(z.string()).nullish(),
    design_sections: z.array(z.string()).nullish(),
    depends_on: z.array(z.number().int().min(1)).nullish(),
    validation_commands: z.array(z.string()).nullish(),
    migration_constraints: z.array(z.string()).nullish(),
    out_of_scope: z.array(z.string()).nullish(),
    invariants: z
      .array(
        z.object({
          name: z.string().min(1),
          description: z.string().min(1),
          test_case_name: z.string().min(1),
        }),
      )
      .nullish(),
    signature_changes: z.array(signatureChangeSchema).nullish(),
    files: z.array(z.string()).nullish(),
    validation: z.array(z.string()).nullish(),
  })
  .passthrough();

export const taskManifestV2Schema = z
  .object({
    version: z.literal(2),
    task_count: z.number().int().min(0),
    tasks: z.array(taskManifestEntryV2Schema),
  })
  .passthrough()
  .superRefine((manifest, ctx) => {
    for (const [taskIndex, task] of manifest.tasks.entries()) {
      const ownedFiles = new Set(
        [...(task.expected_files ?? []), ...(task.files ?? [])].map((f) => f.replace(/\\/g, '/')),
      );
      if (task.signature_changes) {
        for (const [scIndex, sc] of task.signature_changes.entries()) {
          if (!ownedFiles.has(sc.declaration_file.replace(/\\/g, '/'))) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "each signature_changes declaration_file must be in the task's expected_files or files",
              path: ['tasks', taskIndex, 'signature_changes', scIndex, 'declaration_file'],
            });
          }
        }
      }
    }
  });

export const taskManifestSchema = z.union([taskManifestV1Schema, taskManifestV2Schema]);

export type TaskManifestEntryV1 = z.infer<typeof taskManifestEntryV1Schema>;
export type TaskManifestV1 = z.infer<typeof taskManifestV1Schema>;
export type TaskManifestEntryV2 = z.infer<typeof taskManifestEntryV2Schema>;
export type TaskManifestV2 = z.infer<typeof taskManifestV2Schema>;
export type TaskManifest = z.infer<typeof taskManifestSchema>;
export type TaskManifestEntry = TaskManifest['tasks'][number];
