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

// Keep in sync with AgentRuntimeKind in @ai-sdlc/application/agent/types.ts
const agentRuntime = z.enum(['opencode', 'pi']);

const nonBlankString = z.string().trim().min(1);

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

const phaseProfileEntrySchema = z.strictObject({
  profile: nonBlankString,
  fallbackProfile: nonBlankString.optional(),
});

const agentSchema = z
  .strictObject({
    defaultProfile: nonBlankString,
    profiles: z.record(nonBlankString, agentProfileSchema),
    phaseProfiles: z.record(nonBlankString, phaseProfileEntrySchema),
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
    }
  });

export const orchestratorConfigSchema = z.object({
  validation: validationSchema,
  phases: phasesSchema,
  timeouts: timeoutsSchema,
  agent: agentSchema.optional(),
});

export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;
export type AgentConfig = NonNullable<OrchestratorConfig['agent']>;
