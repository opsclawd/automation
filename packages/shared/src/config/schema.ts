import { z } from 'zod';

const validationSchema = z.object({
  commands: z.array(z.string().min(1)).min(1),
  timeout: z.number().int().positive(),
});

const phasesSchema = z.object({
  skip: z.array(z.string()).default([]),
  reviewFix: z.object({ maxIterations: z.number().int().positive() }),
  implement: z.object({ maxIterations: z.number().int().positive() }),
});

const timeoutsSchema = z.object({
  readyMaxDays: z.number().int().positive(),
  invocationMaxMinutes: z.number().int().positive(),
});

// Keep in sync with AgentRuntimeKind in @ai-sdlc/domain/agent-types.ts
const agentRuntime = z.enum(['opencode', 'pi', 'antigravity']);

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
]);

const phaseProfileEntrySchema = z.strictObject({
  profile: nonBlankString,
  fallbackProfile: nonBlankString.optional(),
  fallbackTriggers: z.array(fallbackTriggerSchema).optional(),
});

const agentSchema = z
  .strictObject({
    defaultProfile: nonBlankString,
    profiles: z.record(recordKeySchema, agentProfileSchema),
    phaseProfiles: z.record(recordKeySchema, phaseProfileEntrySchema),
  })
  .superRefine((agent, ctx) => {
    const names = new Set(Object.keys(agent.profiles));
    if (!names.has(agent.defaultProfile)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultProfile'],
        message: `defaultProfile '${agent.defaultProfile}' is not defined in profiles`,
      });
    }
    for (const [phaseName, entry] of Object.entries(agent.phaseProfiles)) {
      if (!names.has(entry.profile)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phaseProfiles', phaseName, 'profile'],
          message: `phaseProfiles.${phaseName}.profile '${entry.profile}' is not defined in profiles`,
        });
      }
      if (entry.fallbackProfile && !names.has(entry.fallbackProfile)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phaseProfiles', phaseName, 'fallbackProfile'],
          message: `phaseProfiles.${phaseName}.fallbackProfile '${entry.fallbackProfile}' is not defined in profiles`,
        });
      }
      if (entry.fallbackTriggers && !entry.fallbackProfile) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phaseProfiles', phaseName, 'fallbackTriggers'],
          message: `phaseProfiles.${phaseName} has fallbackTriggers but no fallbackProfile; triggers require a fallback to be useful`,
        });
      }
    }
  });

export const orchestratorConfigSchema = z.strictObject({
  validation: validationSchema,
  phases: phasesSchema,
  timeouts: timeoutsSchema,
  agent: agentSchema.optional(),
});

export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;
export type AgentConfig = NonNullable<OrchestratorConfig['agent']>;
