import { z } from 'zod';

// WARNING: Bash orchestrator startup merge (scripts/ai-run-issue-v2) uses
//   jq -s '.[0] * .[1]'
// to combine base and local config. jq's '*' operator CONCATENATES arrays
// rather than replacing them like TypeScript deepMerge. Any config key
// consumed by the bash orchestrator MUST NOT hold an array value, or the merge
// will silently produce duplicate entries instead of an override.

const validationSchema = z.object({
  commands: z.array(z.string().min(1)).min(1),
  timeout: z.number().int().positive(),
});

const phasesSchema = z.object({
  skip: z.array(z.string()).default([]),
  reviewFix: z.object({
    maxIterations: z.number().int().positive(),
    blockOnSeverity: z.enum(['critical', 'high', 'medium', 'low']).optional().default('high'),
  }),
  // implement.maxIterations is validated but not consumed by any shell loop.
  // The implement phase runs each task once sequentially — no retry loop exists.
  implement: z.object({ maxIterations: z.number().int().positive() }),
  wholePrFix: z.object({ maxIterations: z.number().int().positive() }).optional(),
  fixValidate: z
    .object({
      maxIterations: z.number().int().positive(),
      enabled: z.boolean().default(true),
    })
    .optional(),
  planReview: z
    .object({
      maxIterations: z.number().int().positive(),
      enabled: z.boolean().default(true),
      judgmentAgent: z.string().min(1).optional(),
    })
    .optional(),
  // Post-PR review poller (scripts/ai-pr-review-poll) settings. When absent, the
  // Bash launcher falls back to maxPolls=3 / pollIntervalSeconds=300.
  postPrReview: z
    .object({
      maxPolls: z.number().int().positive(),
      pollIntervalSeconds: z.number().int().positive(),
    })
    .optional(),
});

const timeoutsSchema = z.object({
  readyMaxDays: z.number().int().positive(),
  invocationMaxMinutes: z.number().int().positive(),
});

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
    sandboxMode: z.enum(['read-only', 'writable']).optional(),
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

      // fallbackTriggers requires a fallback target
      if (entry.fallbackTriggers && !entry.fallbackProfile && !entry.fallbackRole) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phaseProfiles', phaseName, 'fallbackTriggers'],
          message: `phaseProfiles.${phaseName} has fallbackTriggers but no fallbackProfile or fallbackRole; triggers require a fallback to be useful`,
        });
      }
    }
  });

export const orchestratorConfigSchema = z
  .strictObject({
    validation: validationSchema,
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
  })
  .superRefine((config, ctx) => {
    const judgmentAgent = config.phases.planReview?.judgmentAgent;
    if (judgmentAgent && config.agent) {
      const profileNames = new Set(Object.keys(config.agent.profiles));
      if (!profileNames.has(judgmentAgent)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phases', 'planReview', 'judgmentAgent'],
          message: `phases.planReview.judgmentAgent '${judgmentAgent}' is not defined in agent.profiles`,
        });
      }
    }
  });

export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;
export type AgentConfig = NonNullable<OrchestratorConfig['agent']>;
