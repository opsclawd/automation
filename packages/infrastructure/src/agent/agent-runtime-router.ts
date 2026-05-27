import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import {
  AgentInvocationId,
  AgentProfileName,
  PhaseName,
  RunId,
  type AgentInvocation,
  type AgentRuntimeKind,
} from '@ai-sdlc/domain';
import {
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
  type AgentInvocationPort,
  CONTRACT_VIOLATION_CODES,
} from '@ai-sdlc/application';
import { ConfigError, type AgentConfig, type OrchestratorEvent } from '@ai-sdlc/shared';
import type { EventBusPort } from '@ai-sdlc/application';

export interface AgentRuntimeRouterOptions {
  agent: AgentConfig;
  adapters: Partial<Record<AgentRuntimeKind, AgentPort>>;
  invocationRepository: AgentInvocationPort;
  eventBus?: EventBusPort;
  clock?: () => Date;
  idFactory?: () => string;
  readPromptChars?: (path: string) => number;
  env?: Record<string, string | undefined>;
}

export class AgentRuntimeRouter implements AgentPort {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly readPromptChars: (path: string) => number;
  private readonly env: Record<string, string | undefined>;

  constructor(private readonly opts: AgentRuntimeRouterOptions) {
    this.clock = opts.clock ?? (() => new Date());
    this.idFactory = opts.idFactory ?? (() => randomUUID());
    this.readPromptChars = opts.readPromptChars ?? defaultReadPromptChars;
    this.env = opts.env ?? process.env;
  }

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    const isCallerSignalled = !!request.fallbackOfInvocationId;

    if (isCallerSignalled && request.fallbackOfInvocationId) {
      const reason = request.fallbackReason ?? 'unknown';
      const triggerReason = reason.length > 64 ? reason.slice(0, 64) : reason;
      const previous = this.opts.invocationRepository.findById(request.fallbackOfInvocationId);
      const fromProfile = previous?.profile ?? 'unknown';

      this.emitFallbackEvent(
        request.runId,
        fromProfile,
        request.profile,
        triggerReason,
        'use_case',
      );
    }

    const result = await this.dispatch(request, isCallerSignalled);
    return result;
  }

  private async dispatch(
    request: AgentInvocationRequest,
    isFallbackOrCallerSignalled?: boolean,
  ): Promise<AgentInvocationResult> {
    const profile = this.opts.agent.profiles[request.profile];
    if (!profile) {
      throw new ConfigError(`unknown profile '${request.profile}'`);
    }
    const adapter = this.opts.adapters[profile.runtime];
    if (!adapter) {
      throw new ConfigError(`no adapter registered for runtime '${profile.runtime}'`);
    }

    const { provider: effectiveProvider, model: effectiveModel } = this.effectiveProfile(profile);

    const id = AgentInvocationId(this.idFactory());
    const startedAt = this.clock();
    const promptChars = this.readPromptChars(request.promptPath);
    const pre: AgentInvocation = {
      id,
      runId: RunId(request.runId),
      phaseId: PhaseName(request.phaseId),
      profile: request.profile,
      runtime: profile.runtime,
      provider: effectiveProvider,
      model: effectiveModel,
      promptPath: request.promptPath,
      promptChars,
      stdoutPath: '',
      stderrPath: '',
      startedAt,
      startCommitSha: request.startCommitSha,
      timeoutMs: profile.timeoutMinutes * 60_000,
      contractViolations: [],
    };
    if (request.stepId) {
      pre.stepId = request.stepId;
    }
    if (request.fallbackOfInvocationId) {
      pre.fallbackOfInvocationId = request.fallbackOfInvocationId;
    }
    this.opts.invocationRepository.insert(pre);

    let profileTimeoutSignal: AbortSignal | undefined;
    const signals: AbortSignal[] = [];
    if (profile.timeoutMinutes > 0) {
      profileTimeoutSignal = AbortSignal.timeout(profile.timeoutMinutes * 60_000);
      signals.push(profileTimeoutSignal);
    }
    if (request.abortSignal) {
      signals.push(request.abortSignal);
    }
    const composedSignal =
      signals.length === 0
        ? undefined
        : signals.length === 1
          ? signals[0]
          : AbortSignal.any(signals);

    const hints: AgentInvocationRequest['runtimeHints'] = {};
    if (profile.contextLimitTokens !== undefined)
      hints.contextLimitTokens = profile.contextLimitTokens;
    if (profile.outputBudgetTokens !== undefined)
      hints.outputBudgetTokens = profile.outputBudgetTokens;
    const runtimeHints =
      hints.contextLimitTokens !== undefined || hints.outputBudgetTokens !== undefined
        ? hints
        : undefined;

    const enrichedRequest: AgentInvocationRequest = {
      ...request,
      ...(composedSignal ? { abortSignal: composedSignal } : {}),
      provider: effectiveProvider,
      model: effectiveModel,
      ...(profile.promptBudgetTokens !== undefined
        ? { promptBudgetTokens: profile.promptBudgetTokens }
        : {}),
      ...(runtimeHints !== undefined ? { runtimeHints } : {}),
    };

    let result: AgentInvocationResult;
    try {
      result = await adapter.invoke(enrichedRequest);
    } catch (err) {
      this.opts.invocationRepository.update(id, {
        endedAt: this.clock(),
        outcome: 'failed',
        contractViolations: [],
      });
      throw err;
    }

    if (
      result.outcome === 'failed' &&
      result.contractViolations.includes('cancelled_by_orchestrator') &&
      profileTimeoutSignal?.aborted &&
      !request.abortSignal?.aborted
    ) {
      result = { ...result, outcome: 'timeout', contractViolations: [] };
    }

    const endedAt = this.clock();
    const patch: Parameters<AgentInvocationPort['update']>[1] = {
      endedAt,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outcome: result.outcome,
      contractViolations: result.contractViolations,
      stdoutPath: result.stdoutPath,
      stderrPath: result.stderrPath,
    };
    if (result.resultJsonPath) {
      patch.resultJsonPath = result.resultJsonPath;
    }
    if (result.endCommitSha) {
      patch.endCommitSha = result.endCommitSha;
    }
    this.opts.invocationRepository.update(id, patch);

    // --- Adapter-level fallback only (caller-signalled is handled in invoke) ---
    if (!isFallbackOrCallerSignalled && this.shouldFallback(result)) {
      const phaseEntry = this.opts.agent.phaseProfiles[request.phaseId];
      const fallbackProfileName = phaseEntry?.fallbackProfile;
      if (fallbackProfileName) {
        const fallbackProfile = this.opts.agent.profiles[fallbackProfileName];
        if (fallbackProfile) {
          const fallbackAdapter = this.opts.adapters[fallbackProfile.runtime];
          if (fallbackAdapter) {
            const triggerReason = this.determineTriggerReason(result);

            const fallbackRequest: AgentInvocationRequest = {
              ...request,
              profile: AgentProfileName(fallbackProfileName),
              fallbackOfInvocationId: id,
              fallbackReason: triggerReason,
            };

            this.emitFallbackEvent(
              request.runId,
              request.profile,
              fallbackProfileName,
              triggerReason,
              'router',
            );

            const { provider: fbEffectiveProvider, model: fbEffectiveModel } =
              this.effectiveProfile(fallbackProfile);

            const fallbackResult = await this.dispatch(fallbackRequest, true);
            return {
              ...fallbackResult,
              provider: fbEffectiveProvider,
              model: fbEffectiveModel,
            };
          }
        }
      }
    }

    return { ...result, provider: effectiveProvider, model: effectiveModel };
  }

  private shouldFallback(result: AgentInvocationResult): boolean {
    if (result.outcome === 'timeout') return true;
    if (result.outcome === 'contract_violation') return true;
    return false;
  }

  private determineTriggerReason(result: AgentInvocationResult): string {
    if (result.outcome === 'timeout') return 'timeout';
    if (result.outcome === 'contract_violation') {
      if (result.contractViolations.includes(CONTRACT_VIOLATION_CODES.PROMPT_BUDGET_EXCEEDED)) {
        return 'prompt_budget_exceeded';
      }
      if (result.contractViolations.includes(CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT)) {
        return 'missing_required_artifact';
      }
      if (result.contractViolations.includes(CONTRACT_VIOLATION_CODES.INVALID_RESULT_JSON)) {
        return 'invalid_result_json';
      }
      return 'contract_violation';
    }
    return 'unknown';
  }

  private effectiveProfile(p: { provider: string; model: string }): {
    provider: string;
    model: string;
  } {
    return {
      provider: this.env.AI_AGENT_PROVIDER?.trim() || p.provider,
      model: this.env.AI_AGENT_MODEL?.trim() || p.model,
    };
  }

  private emitFallbackEvent(
    runId: string,
    fromProfile: string,
    toProfile: string,
    triggerReason: string,
    triggerOwner: string,
  ): void {
    if (!this.opts.eventBus) return;
    const event: OrchestratorEvent = {
      runId,
      level: 'warn',
      type: 'phase.fallback.escalated',
      message: `Fallback from '${fromProfile}' to '${toProfile}' (reason: ${triggerReason}, owner: ${triggerOwner})`,
      timestamp: this.clock().toISOString(),
      metadata: {
        fromProfile,
        toProfile,
        triggerReason,
        triggerOwner,
      },
    };
    this.opts.eventBus.publish(runId, event);
  }
}

function defaultReadPromptChars(path: string): number {
  try {
    if (statSync(path).size === 0) return 0;
    return readFileSync(path, 'utf-8').length;
  } catch {
    return 0;
  }
}
