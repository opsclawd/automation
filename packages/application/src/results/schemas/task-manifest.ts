import { z } from 'zod';

const repositoryRelativePathSchema = z
  .string()
  .refine((val) => val.trim().length > 0 && val.trim() === val, {
    message: 'path must be a non-empty trimmed repository-relative path',
  })
  .refine((val) => !val.includes('\\'), {
    message: 'path must use forward slashes, not backslashes',
  })
  .refine((val) => !val.startsWith('/'), {
    message: 'path must be a repository-relative path, not absolute',
  })
  .refine((val) => !val.endsWith('/'), {
    message: 'path must not end with a trailing slash',
  })
  .refine(
    (val) => {
      const segments = val.split('/');
      return !segments.some((seg) => seg === '' || seg === '.' || seg === '..');
    },
    {
      message: 'path must not contain empty, single-dot, or parent-dot segments',
    },
  );

export const signatureChangeSchema = z
  .object({
    declaration_file: repositoryRelativePathSchema,
    symbol: z.string().trim().min(1, { message: 'symbol must be a non-empty string' }),
    change: z.enum(['added', 'modified', 'not_modified']).optional().default('modified'),
    breaking: z.boolean().optional(),
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

const validationCommandSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const defaultEmptyPathArraySchema = z
  .preprocess(
    (val) => (val === null || val === undefined ? [] : val),
    z.array(repositoryRelativePathSchema),
  )
  .default([]);

export const taskManifestEntryV2Schema = z
  .object({
    n: z.number().int().min(1),
    title: z.string().min(1),
    description: z.string().nullish(),
    acceptance_criteria: z.array(z.string()).nullish(),
    expected_files: z.array(repositoryRelativePathSchema).nullish(),
    permitted_areas: defaultEmptyPathArraySchema,
    may_extend: defaultEmptyPathArraySchema,
    non_goals: defaultEmptyPathArraySchema,
    reference_files: defaultEmptyPathArraySchema,
    relevant_symbols: z.array(z.string()).nullish(),
    design_sections: z.array(z.string()).nullish(),
    depends_on: z.array(z.number().int().min(1)).nullish(),
    validation_commands: z.array(validationCommandSchema).nullish(),
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
    files: z.array(repositoryRelativePathSchema).nullish(),
    validation: z.array(z.string()).nullish(),
  })
  .passthrough();

function isSameOrDescendant(ancestor: string, target: string): boolean {
  return ancestor === target || target.startsWith(ancestor + '/');
}

function pathsOverlapBySegment(a: string, b: string): boolean {
  return isSameOrDescendant(a, b) || isSameOrDescendant(b, a);
}

export const taskManifestV2Schema = z
  .object({
    version: z.literal(2),
    task_count: z.number().int().min(0),
    tasks: z.array(taskManifestEntryV2Schema),
  })
  .passthrough()
  .superRefine((manifest, ctx) => {
    for (const [taskIndex, task] of manifest.tasks.entries()) {
      const expectedFiles = task.expected_files ?? [];
      const legacyFiles = task.files ?? [];
      const mayExtendFiles = task.may_extend ?? [];
      const permittedAreas = task.permitted_areas ?? [];
      const referenceFiles = task.reference_files ?? [];
      const nonGoals = task.non_goals ?? [];

      const writableExact = [...expectedFiles, ...legacyFiles];
      const allWritable = [...writableExact, ...mayExtendFiles];

      // 1. Reject reference_files overlap with writable exact declarations (expected_files, files, may_extend)
      const exactWritableSet = new Set(allWritable);
      for (const refFile of referenceFiles) {
        if (exactWritableSet.has(refFile)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `reference file '${refFile}' cannot overlap with writable declarations`,
            path: ['tasks', taskIndex, 'reference_files'],
          });
        }
      }

      // 2. Reject duplicate may_extend obligations (may_extend overlap with expected_files or files)
      const obligationSet = new Set(writableExact);
      for (const meFile of mayExtendFiles) {
        if (obligationSet.has(meFile)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `may_extend file '${meFile}' cannot duplicate expected_files obligation`,
            path: ['tasks', taskIndex, 'may_extend'],
          });
        }
      }

      // 3. Reject non_goals that contain or are contained by any writable exact path or permitted area
      for (const ngPath of nonGoals) {
        for (const writablePath of allWritable) {
          if (pathsOverlapBySegment(ngPath, writablePath)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `non_goals path '${ngPath}' cannot overlap with writable path '${writablePath}'`,
              path: ['tasks', taskIndex, 'non_goals'],
            });
          }
        }
        for (const areaPath of permittedAreas) {
          if (pathsOverlapBySegment(ngPath, areaPath)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `non_goals path '${ngPath}' cannot overlap with permitted area '${areaPath}'`,
              path: ['tasks', taskIndex, 'non_goals'],
            });
          }
        }
      }

      // 4. Validate signature changes
      if (task.signature_changes) {
        const writableSet = new Set(writableExact);
        const refSet = new Set(referenceFiles);
        for (const [scIndex, sc] of task.signature_changes.entries()) {
          const declFileNormalized = sc.declaration_file.replace(/\\/g, '/');
          const isWritable = writableSet.has(declFileNormalized);
          const isReference = refSet.has(declFileNormalized);
          const change = sc.change ?? 'modified';

          if (change === 'not_modified') {
            if (!isWritable && !isReference) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                  "each signature_changes declaration_file must be in the task's expected_files, files, or reference_files",
                path: ['tasks', taskIndex, 'signature_changes', scIndex, 'declaration_file'],
              });
            }
          } else {
            if (!isWritable) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                  "each signature_changes declaration_file with change 'modified' or 'added' must be in expected_files or files",
                path: ['tasks', taskIndex, 'signature_changes', scIndex, 'declaration_file'],
              });
            }
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
