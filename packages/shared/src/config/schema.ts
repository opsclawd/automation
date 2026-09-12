import { z } from 'zod';

// WARNING: Bash orchestrator startup merge (scripts/ai-run-issue-v2) uses
//   jq -s '.[0] * .[1]'
// to combine base and local config. jq's '*' operator CONCATENATES arrays
// rather than replacing them like TypeScript deepMerge. Any config key
// consumed by the bash orchestrator MUST NOT hold an array value, or the merge
// will silently produce duplicate entries instead of an override.

const validationSchema = z.object({
  commands: z.array(z.string().min(1)).min(1),
  additionalCommands: z.array(z.string().trim().min(1)).optional(),
  selfVerifyCommands: z.array(z.string().trim().min(1)).optional(),
  tiers: z.array(z.array(z.string().min(1)).min(1)).optional(),
  timeout: z.number().int().positive(),
  forbiddenArtifactPaths: z.array(z.string().trim().min(1)).optional(),
  narrowByChangedFiles: z.boolean().default(true),
  commandScopes: z.record(z.string().trim().min(1), z.array(z.string().trim().min(1))).optional(),
});

const phasesSchema = z.object({
  skip: z.array(z.string()).default([]),
  reviewConvergence: z
    .object({
      maxIterations: z.number().int().positive().default(4),
    })
    .optional(),
  implement: z
    .object({
      /**
       * Exact repository-relative paths that may be committed even when absent from
       * the current task's expected_files/files surface. Matching and path
       * normalization are owned by ImplementHandler; no implicit exemptions apply.
       */
      exemptUndeclaredFiles: z.array(z.string()).default([]),
    })
    .default({ exemptUndeclaredFiles: [] }),
  fixValidate: z
    .object({
      maxIterations: z.number().int().positive(),
      enabled: z.boolean().default(true),
    })
    .optional(),
  // Architecture review phase (strict policy) iteration budget.
  // maxCorrections: 0 = review-only; 1 = 1 correction + 1 verify; 2 = up to 2 corrections (default).
  architectureReview: z
    .object({
      maxCorrections: z.number().int().min(0).max(5).default(2),
    })
    .default({ maxCorrections: 2 }),
  // Lean wait-merge phase's bounded in-process poll loop for CI/merge
  // readiness. Defaults: wait 10 minutes before the first check (CI
  // typically takes 6-8 minutes to report), then re-check every 2 minutes
  // for up to 5 more checks (6 checks total, ~20 minutes after the initial
  // delay) before parking the phase as resting.
  waitMerge: z
    .object({
      maxPolls: z.number().int().positive().default(6),
      pollIntervalSeconds: z.number().int().positive().default(120),
      initialDelaySeconds: z.number().int().nonnegative().default(600),
    })
    .optional(),
});

const timeoutsSchema = z.object({
  readyMaxDays: z.number().int().positive(),
  invocationMaxMinutes: z.number().int().positive(),
});

const governanceSchema = z
  .object({
    protectedPaths: z.array(z.string().trim().min(1)).default([]),
  })
  .default({ protectedPaths: [] });

export const schedulerConfigSchema = z
  .strictObject({
    globalConcurrency: z.number().int().positive().default(1),
    pollIntervalMs: z.number().int().positive().default(2_000),
    shutdownGraceMs: z.number().int().positive().default(30_000),
  })
  .default({ globalConcurrency: 1, pollIntervalMs: 2_000, shutdownGraceMs: 30_000 });

// Keep in sync with AgentRuntimeKind in @ai-sdlc/domain/agent-types.ts
const agentRuntime = z.enum(['opencode', 'pi', 'antigravity', 'claude-code', 'codex']);

const nonBlankString = z.string().trim().min(1);

const recordKeySchema = z
  .string()
  .min(1)
  .refine((v) => v === v.trim(), 'key must not have leading or trailing whitespace');

const agentProfileSchema = z
  .strictObject({
    runtime: agentRuntime,
    provider: nonBlankString,
    model: nonBlankString,
    variant: z.enum(['low', 'medium', 'high']).optional(),
    contextLimitTokens: z.number().int().positive().optional(),
    promptBudgetTokens: z.number().int().positive().optional(),
    outputBudgetTokens: z.number().int().positive().optional(),
    timeoutMinutes: z.number().positive(), // fractional minutes intentionally allowed (e.g. 0.5)
  })
  .superRefine((profile, ctx) => {
    if (profile.runtime === 'pi' && profile.contextLimitTokens === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contextLimitTokens'],
        message: 'pi profiles require contextLimitTokens',
      });
    }
  });

const fallbackTriggerSchema = z.enum([
  'timeout',
  'contract_violation',
  'missing_required_artifact',
  'prompt_budget_exceeded',
  'invalid_result_json',
  'runtime_error',
  'token_limit_exceeded',
  'quota_exceeded',
  'provider_error',
  'no_output',
  'synthesized_from_transcript',
]);

const roleEntrySchema = z.strictObject({
  profile: nonBlankString,
  fallback: nonBlankString.optional(),
});

const phaseProfileEntrySchema = z.strictObject({
  profile: nonBlankString.optional(),
  fallbackProfile: nonBlankString.optional(),
  fallbackTriggers: z.array(fallbackTriggerSchema).optional(),
  role: nonBlankString.optional(),
  fallbackRole: nonBlankString.optional(),
});

const agentSchema = z
  .strictObject({
    defaultProfile: nonBlankString,
    profiles: z.record(recordKeySchema, agentProfileSchema),
    roles: z.record(recordKeySchema, roleEntrySchema).optional(),
    phaseProfiles: z.record(recordKeySchema, phaseProfileEntrySchema),
  })
  .superRefine((agent, ctx) => {
    const profileNames = new Set(Object.keys(agent.profiles));
    const roleNames = new Set(Object.keys(agent.roles ?? {}));

    if (!profileNames.has(agent.defaultProfile)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultProfile'],
        message: `defaultProfile '${agent.defaultProfile}' is not defined in profiles`,
      });
    }

    if (agent.roles) {
      for (const [roleName, roleEntry] of Object.entries(agent.roles)) {
        if (!profileNames.has(roleEntry.profile)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['roles', roleName, 'profile'],
            message: `roles.${roleName}.profile '${roleEntry.profile}' is not defined in profiles`,
          });
        }
        if (roleEntry.fallback && !profileNames.has(roleEntry.fallback)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['roles', roleName, 'fallback'],
            message: `roles.${roleName}.fallback '${roleEntry.fallback}' is not defined in profiles`,
          });
        }
      }
    }

    for (const [phaseName, entry] of Object.entries(agent.phaseProfiles)) {
      // Mutual exclusion: profile and role
      if (entry.profile && entry.role) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phaseProfiles', phaseName],
          message: `phaseProfiles.${phaseName} has both profile and role; use one or the other`,
        });
        continue;
      }
      // Mutual exclusion: fallbackProfile and fallbackRole
      if (entry.fallbackProfile && entry.fallbackRole) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phaseProfiles', phaseName],
          message: `phaseProfiles.${phaseName} has both fallbackProfile and fallbackRole; use one or the other`,
        });
      }
      // Must have at least one of profile or role
      if (!entry.profile && !entry.role) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phaseProfiles', phaseName],
          message: `phaseProfiles.${phaseName} must have either profile or role`,
        });
        continue;
      }

      // Validate profile membership
      if (entry.profile && !profileNames.has(entry.profile)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phaseProfiles', phaseName, 'profile'],
          message: `phaseProfiles.${phaseName}.profile '${entry.profile}' is not defined in profiles`,
        });
      }

      // Validate role membership and its referenced profile/fallback
      if (entry.role) {
        if (!roleNames.has(entry.role)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['phaseProfiles', phaseName, 'role'],
            message: `phaseProfiles.${phaseName}.role '${entry.role}' is not defined in roles`,
          });
        } else {
          const roleProfile = agent.roles![entry.role]!.profile;
          if (!profileNames.has(roleProfile)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['phaseProfiles', phaseName, 'role'],
              message: `phaseProfiles.${phaseName}.role '${entry.role}' references profile '${roleProfile}' which is not defined in profiles`,
            });
          }
          const roleFallback = agent.roles![entry.role]!.fallback;
          if (roleFallback && !profileNames.has(roleFallback)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['phaseProfiles', phaseName, 'role'],
              message: `roles.${entry.role}.fallback '${roleFallback}' is not defined in profiles`,
            });
          }
        }
      }

      // Validate fallbackProfile membership
      if (entry.fallbackProfile && !profileNames.has(entry.fallbackProfile)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phaseProfiles', phaseName, 'fallbackProfile'],
          message: `phaseProfiles.${phaseName}.fallbackProfile '${entry.fallbackProfile}' is not defined in profiles`,
        });
      }

      // Validate fallbackRole membership and its referenced profile
      if (entry.fallbackRole) {
        if (!roleNames.has(entry.fallbackRole)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['phaseProfiles', phaseName, 'fallbackRole'],
            message: `phaseProfiles.${phaseName}.fallbackRole '${entry.fallbackRole}' is not defined in roles`,
          });
        } else {
          const fbRoleProfile = agent.roles![entry.fallbackRole]!.profile;
          if (!profileNames.has(fbRoleProfile)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['phaseProfiles', phaseName, 'fallbackRole'],
              message: `phaseProfiles.${phaseName}.fallbackRole '${entry.fallbackRole}' references profile '${fbRoleProfile}' which is not defined in profiles`,
            });
          }
        }
      }

      // fallbackTriggers requires a fallback target — either an explicit fallbackProfile/
      // fallbackRole on the phase entry, or a role-level fallback that normalizeRoles
      // will later promote into fallbackProfile.
      if (entry.fallbackTriggers && !entry.fallbackProfile && !entry.fallbackRole) {
        const roleHasFallback = entry.role && agent.roles?.[entry.role]?.fallback;
        if (!roleHasFallback) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['phaseProfiles', phaseName, 'fallbackTriggers'],
            message: `phaseProfiles.${phaseName} has fallbackTriggers but no fallbackProfile, fallbackRole, or role-level fallback; triggers require a fallback to be useful`,
          });
        }
      }
    }
  });

export const EXECUTION_POLICIES = ['standard', 'strict'] as const;
export const DEFAULT_EXECUTION_POLICY = 'standard';

export const executionPolicySchema = z.enum(EXECUTION_POLICIES).default(DEFAULT_EXECUTION_POLICY);

export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;

export const orchestratorConfigSchema = z.strictObject({
  executionPolicy: executionPolicySchema,
  validation: validationSchema,
  governance: governanceSchema.default({ protectedPaths: [] }),
  phases: phasesSchema,
  timeouts: timeoutsSchema,
  agent: agentSchema.optional(),
  taskSplitting: z
    .object({
      maxTestFileLines: z.number().int().positive().default(500),
      maxTestCases: z.number().int().positive().default(10),
      blockOversizedTasks: z.boolean().default(false),
    })
    .default({
      maxTestFileLines: 500,
      maxTestCases: 10,
      blockOversizedTasks: false,
    }),
  serve: z
    .object({
      /**
       * Interval, in seconds, at which `orchestrator serve` re-runs
       * SweepWaitingRuns and drives any reactivated run with the worker
       * loop. 0 (the default) disables the periodic sweep entirely —
       * `serve` behaves exactly as it does today (a single startup sweep,
       * no periodic re-check). A positive value is clamped to a minimum
       * of 30s by the CLI wiring (Task 6) to avoid hammering the GitHub
       * API/DB if misconfigured.
       */
      sweepIntervalSeconds: z.number().int().nonnegative().default(0),
    })
    .default({ sweepIntervalSeconds: 0 }),
  features: z
    .object({
      scopeContractEnforcement: z.boolean().default(true),
    })
    .default({}),
  notifications: z
    .object({
      runWebhookUrl: z.string().url().optional(),
    })
    .default({}),
  scheduler: schedulerConfigSchema,
});

/**
 * Default grace window (in seconds) the poller keeps polling an empty PR
 * before allowing the quiet-poll counter to advance. Must remain an
 * integer-seconds value so the bash orchestrator (which uses jq/awk math)
 * can mirror it if/when ported.
 */
export const DEFAULT_FIRST_REVIEW_GRACE_WINDOW_SECONDS = 1800;

export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;
export type AgentConfig = NonNullable<OrchestratorConfig['agent']>;
