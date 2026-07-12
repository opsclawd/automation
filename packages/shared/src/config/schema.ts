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
    /**
     * Threshold for the `unfounded_pingpong` short-circuit (#623). When the
     * last N iterations all have findings whose evidence fails the
     * mechanical check AND the fixer returned `done_no_fixes_needed`, the
     * loop short-circuits to `needs_human_review`. Defaults to 4 when
     * omitted; set higher to be more tolerant of bursty reviewer models.
     */
    unfoundedPingPongLimit: z.number().int().positive().optional().default(4),
    /**
     * When true (default), the budget grants one trailing post-fix re-review
     * whenever the last iteration ended with `outcome: 'fixed'`. Set to
     * false to restore pre-#627 behavior bit-for-bit (#627).
     */
    endOnReview: z.boolean().default(true),
    /**
     * When true (default), iteration >= 2 scopes the reviewer to the diff
     * since the previously reviewed commit. Set to false to disable (#627).
     */
    deltaScopedReReview: z.boolean().default(true),
    /**
     * Trend-aware exit (#627). When enabled (default true, strict mode,
     * window 3), budget exhaustion with a converging severity-weighted
     * finding trend exits as `converged_with_notes` (with
     * `needsHumanReview: true`) instead of failing the run.
     */
    trendAwareExit: z
      .object({
        enabled: z.boolean().default(true),
        mode: z.enum(['strict', 'lenient']).default('strict'),
        window: z.number().int().min(2).max(10).default(3),
      })
      .default({}),
    /**
     * Cap on consecutive fixer failures (verdict !== 'done_with_fixes',
     * including 'cannot_fix' and contract-violation outcomes). When the
     * loop hits this many in a row, it exits early as `exhausted` with
     * `needsHumanReview: true` rather than continuing to burn the
     * `maxIterations` budget on a pathologically failing fixer.
     * Replaces the legacy cap on retries per task (which was
     * never enforced — see issue #667). Omit (or set to 0) to disable.
     * Defaults to undefined (no cap beyond the existing heuristics).
     */
    maxConsecutiveFixFailures: z.number().int().nonnegative().optional(),
    /**
     * Cap on total fix invocations whose verdict was `done_with_fixes`
     * (productive fix work). Bounded to prevent a runaway reviewer
     * emitting unbounded findings from consuming unbounded fixer
     * invocations. Replaces the legacy cap on total tasks
     * (never enforced). Omit (or set to 0) to disable. Defaults to
     * undefined (no cap).
     */
    maxTotalFixAttempts: z.number().int().nonnegative().optional(),
    /**
     * Architect pass (#668). When enabled, the executor invokes the
     * `fix-review-architect` agent once before the review-fix loop begins
     * and threads the produced `review-fix-plan.json` into the loop as
     * `architectPlan`. When disabled (default), the loop runs without a
     * plan and no architect invocation occurs. Mirrors the legacy
     * `architectPass.enabled` flag in `scripts/legacy/ai-run-issue-v2:4394`.
     */
    architectPass: z
      .object({
        enabled: z.boolean().default(false),
        /**
         * Outer timeout for the architect invocation in minutes. The
         * agent-level `timeoutMinutes` already bounds the runtime; this
         * is an additional cap on how long the executor will wait for
         * `review-fix-plan.json` to appear. Defaults to 10 (matches the
         * legacy `TIMEOUT_FIX_REVIEW_ARCHITECT` default in the shell
         * orchestrator).
         */
        timeoutMinutes: z.number().int().positive().default(10),
      })
      .default({ enabled: false, timeoutMinutes: 10 }),
  }),
  // implement.maxIterations is validated but not consumed by any shell loop.
  // The implement phase runs each task once sequentially — no retry loop exists.
  implement: z.object({
    maxIterations: z.number().int().positive(),
    /**
     * The maximum number of typecheck retries during the implement phase.
     * Must be a positive integer (>= 1) to retain proper observability and error logging.
     * Defaults to 5 when read via configuration. Programmatic API (consumers of
     * `ImplementStepLoopInput` that omit the field) falls back to
     * `DEFAULT_MAX_TYPE_CHECK_RETRIES` exported from
     * `@ai-sdlc/application/inplement-step-loop`.
     */
    maxTypeCheckRetries: z.number().int().positive().default(5),
    /**
     * When true (default), iteration >= 2 scopes the reviewer to the diff
     * since the previously reviewed commit for intermediate reviews.
     * Set to false to disable delta-scoped re-review for intermediate passes.
     * Initial full review and final full review are always mandatory and
     * cannot be disabled by configuration (#723).
     */
    deltaScopedReReview: z.boolean().default(true),
  }),
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
      /**
       * When true (default), iteration >= 2 scopes the reviewer to the prior
       * finding set + their dispositions + citations introduced by the most
       * recent fix, instead of re-reviewing the entire plan from scratch
       * (#716). Mirrors `phases.reviewFix.deltaScopedReReview`.
       */
      deltaScopedReReview: z.boolean().default(true),
    })
    .optional(),
  // Bounded self-repair for plan-write's structural validation (validatePlanTaskList).
  // maxRepairAttempts: 0 reproduces pre-repair-loop behavior (immediate hard-fail on the
  // first validation failure). Defaults to 2 when the whole key or the field is omitted.
  planWrite: z
    .object({
      maxRepairAttempts: z.number().int().nonnegative().default(2),
    })
    .optional(),
  // Post-PR review poller (scripts/ai-pr-review-poll) settings. When absent, the
  // Bash launcher falls back to maxPolls=3 / pollIntervalSeconds=300.
  postPrReview: z
    .object({
      maxPolls: z.number().int().positive(),
      pollIntervalSeconds: z.number().int().positive(),
      /**
       * Maximum seconds the poller will keep polling an empty PR (zero
       * comments) before treating the absence of review activity as a quiet
       * signal. After this window elapses with no reviewer ever commenting,
       * normal quiet-poll accounting takes over and the run may go to
       * `waiting`. Defaults to 1800 (30 min) — exceeds observed reviewer
       * bot latency (~15–20 min) on this repo.
       */
      firstReviewGraceWindowSeconds: z.number().int().positive().optional(),
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

/**
 * Default grace window (in seconds) the poller keeps polling an empty PR
 * before allowing the quiet-poll counter to advance. Must remain an
 * integer-seconds value so the bash orchestrator (which uses jq/awk math)
 * can mirror it if/when ported.
 */
export const DEFAULT_FIRST_REVIEW_GRACE_WINDOW_SECONDS = 1800;

export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;
export type AgentConfig = NonNullable<OrchestratorConfig['agent']>;
