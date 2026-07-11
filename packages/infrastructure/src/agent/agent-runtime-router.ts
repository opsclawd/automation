import { randomUUID, createHash } from 'node:crypto';
import { join, relative, isAbsolute } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import {
  AgentInvocationId,
  AgentProfileName,
  PhaseName,
  RunId,
  type AgentInvocation,
  type AgentRuntimeKind,
} from '@ai-sdlc/domain';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import { CONTRACT_VIOLATION_CODES } from '@ai-sdlc/application/ports';
import type { AgentInvocationPort } from '@ai-sdlc/application/ports';
import type { AgentUsagePort, EventBusPort } from '@ai-sdlc/application/ports';
import { ConfigError, type AgentConfig, type OrchestratorEvent } from '@ai-sdlc/shared';
import {
  testQuotaPatterns,
  testTokenLimitPatterns,
  testProviderErrorPatterns,
} from './error-patterns.js';
import { generateRetryIdentity } from './retry-identity.js';

export interface AgentRuntimeRouterOptions {
  agent: AgentConfig;
  adapters: Partial<Record<AgentRuntimeKind, AgentPort>>;
  invocationRepository: AgentInvocationPort;
  eventBus?: EventBusPort;
  usageRepository?: AgentUsagePort;
  clock?: () => Date;
  idFactory?: () => string;
  readPromptContent?: (path: string) => string;
  /**
   * Legacy test shim used in existing router coverage. If provided, it is
   * treated as a prompt-content reader so retry identity hashing still has
   * deterministic input.
   */
  readPromptChars?: (path: string) => string | number;
  env?: Record<string, string | undefined>;
}

interface TriggerClassification {
  reason: string;
  detail?: string;
  shortDetail?: string;
}

function truncate(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Extract a human-readable error message from a parsed provider-error
 * object, trying progressively more nested shapes. Plain shapes
 * (`{message: "..."}`, `{error: {message: "..."}}`) are checked first.
 * Vercel AI SDK's `AI_APICallError` (seen from minimax and other
 * Anthropic-compatible providers) has no top-level `message` — the real
 * text is nested in `data.error.message` (already-parsed) or
 * `responseBody` (a JSON string that needs its own parse).
 */
function extractErrorMessage(error: Record<string, unknown>): string | undefined {
  if (typeof error.message === 'string') return error.message;
  const data = error.data as Record<string, unknown> | undefined;
  const dataErrorMessage = (data?.error as Record<string, unknown> | undefined)?.message;
  if (typeof dataErrorMessage === 'string') return dataErrorMessage;
  if (typeof data?.message === 'string') return data.message;
  if (typeof error.responseBody === 'string') {
    try {
      const body = JSON.parse(error.responseBody);
      const bodyErrorMessage = body?.error?.message;
      if (typeof bodyErrorMessage === 'string') return bodyErrorMessage;
      if (typeof body?.message === 'string') return body.message;
    } catch {
      // responseBody isn't JSON — nothing to extract
    }
  }
  return undefined;
}

/**
 * Attempt to parse OpenCode's structured JSON error from a log line.
 * If found and parseable, returns a "nice" summary string; otherwise null.
 */
function tryParseOpenCodeError(line: string): string | null {
  const match = /error=(\{.*\})/.exec(line);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!);
    const error = parsed.error || parsed;
    const statusCode = error.statusCode;
    const message = extractErrorMessage(error);
    if (statusCode && message) {
      return `HTTP ${statusCode}: "${message}"`;
    }
    if (message) {
      return `"${message}"`;
    }
  } catch {
    // Malformed JSON — skip
  }
  return null;
}

export class AgentRuntimeRouter implements AgentPort {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly readPromptContent: (path: string) => string;
  private readonly env: Record<string, string | undefined>;

  constructor(private readonly opts: AgentRuntimeRouterOptions) {
    this.clock = opts.clock ?? (() => new Date());
    this.idFactory = opts.idFactory ?? (() => randomUUID());
    this.readPromptContent =
      opts.readPromptContent ??
      (opts.readPromptChars
        ? (path) => String(opts.readPromptChars?.(path) ?? '')
        : defaultReadPromptContent);
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

    const effectiveTimeoutMs = request.timeoutMs ?? profile.timeoutMinutes * 60_000;

    const id = AgentInvocationId(this.idFactory());
    const startedAt = this.clock();
    const promptContent = this.readPromptContent(request.promptPath);
    const promptChars = promptContent.length;
    const promptHash = createHash('sha256').update(promptContent).digest('hex');

    const metadata = { ...request.metadata };
    if (!metadata.invocation_type) {
      metadata.invocation_type = request.fallbackOfInvocationId ? 'fallback' : 'initial';
    }

    let retryIdentity: string | undefined;
    const isSemantic =
      request.retryIntent &&
      request.retryIntent.classification === 'semantic' &&
      metadata.invocation_type !== 'serialization_repair' &&
      metadata.invocation_type !== 'deterministic_fix';
    if (isSemantic && request.retryIntent) {
      retryIdentity = generateRetryIdentity({
        normalizedPhase: request.retryIntent.normalizedPhase,
        profile: request.profile,
        promptHash,
        startCommitSha: request.startCommitSha,
        relevantArtifactPaths: request.retryIntent.relevantArtifactPaths,
        classification: request.retryIntent.classification,
        cwd: request.cwd,
      });
      metadata.retryIdentity = retryIdentity;
      metadata.retry_identity = retryIdentity;
    }

    if (retryIdentity) {
      const priorInvocations = this.opts.invocationRepository.listByRun(RunId(request.runId));
      const hasDuplicate = priorInvocations.some((inv) => {
        const priorIdentity = readRetryIdentity(inv.metadata);
        return priorIdentity === retryIdentity;
      });

      if (hasDuplicate) {
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
          timeoutMs: effectiveTimeoutMs,
          contractViolations: [],
          promptHash,
          metadata,
        };
        if (request.stepId) {
          pre.stepId = request.stepId;
        }
        if (request.fallbackOfInvocationId) {
          pre.fallbackOfInvocationId = request.fallbackOfInvocationId;
        }
        this.opts.invocationRepository.insert(pre);

        const endedAt = this.clock();
        this.opts.invocationRepository.update(id, {
          endedAt,
          outcome: 'duplicate_retry_suppressed',
          exitCode: 0,
          durationMs: 0,
          stdoutPath: '',
          stderrPath: '',
          contractViolations: [],
        });

        return {
          runtime: profile.runtime,
          provider: effectiveProvider,
          model: effectiveModel,
          exitCode: 0,
          durationMs: 0,
          stdoutPath: '',
          stderrPath: '',
          contractViolations: [],
          outcome: 'duplicate_retry_suppressed',
        };
      } else {
        if (this.opts.eventBus) {
          const event: OrchestratorEvent = {
            runId: request.runId,
            level: 'info',
            type: 'semantic_retry',
            message: `Semantic retry detected for phase ${request.phaseId} with identity ${retryIdentity}`,
            timestamp: this.clock().toISOString(),
            metadata: {
              phase: request.phaseId,
              retryIdentity,
            },
          };
          this.opts.eventBus.publish(request.runId, event);
        }
      }
    }

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
      timeoutMs: effectiveTimeoutMs,
      contractViolations: [],
      promptHash,
      metadata,
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
    if (effectiveTimeoutMs > 0) {
      profileTimeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
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
      timeoutMs: effectiveTimeoutMs,
      ...(profile.promptBudgetTokens !== undefined
        ? { promptBudgetTokens: profile.promptBudgetTokens }
        : {}),
      ...(runtimeHints !== undefined ? { runtimeHints } : {}),
    };

    let result: AgentInvocationResult;
    // Clear stale expected artifacts from previous runs before invoking the
    // agent, so a file left over from a prior execution cannot mask a no-op or
    // failed run (#517).
    if (request.expectedArtifacts?.length) {
      for (const artifact of request.expectedArtifacts) {
        const resolvedPath = join(request.cwd, artifact);
        const rel = relative(request.cwd, resolvedPath);
        if (
          !rel ||
          rel === '.' ||
          rel.startsWith('..') ||
          isAbsolute(rel) ||
          isAbsolute(artifact)
        ) {
          throw new Error(`Invalid artifact path (traversal detected): ${artifact}`);
        }
        rmSync(resolvedPath, { recursive: true, force: true });
      }
    }

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

    // Reclassify cancellation as timeout when either the profile timeout
    // or the caller timeout (AbortSignal.timeout()) fired. Distinguish
    // caller timeout from a user-initiated abort (Ctrl-C) by checking
    // the abort reason — AbortSignal.timeout() always produces a
    // DOMException with name 'TimeoutError', while controller.abort()
    // without arguments sets reason to undefined.
    const isCallerTimeout =
      request.abortSignal?.aborted &&
      request.abortSignal.reason instanceof DOMException &&
      request.abortSignal.reason.name === 'TimeoutError';

    if (
      result.outcome === 'failed' &&
      result.contractViolations.includes(CONTRACT_VIOLATION_CODES.CANCELLED_BY_ORCHESTRATOR) &&
      (profileTimeoutSignal?.aborted || isCallerTimeout)
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

    // Persist token usage if the adapter reported it
    // NOTE: wrapped in try/catch so a DB error doesn't skip the fallback
    // check below. The invocation has already been updated as completed.
    if (result.usage && this.opts.usageRepository) {
      try {
        this.opts.usageRepository.insert({
          invocationId: id,
          runId: RunId(request.runId),
          phaseId: PhaseName(request.phaseId),
          profile: request.profile,
          provider: effectiveProvider,
          model: effectiveModel,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          ...(result.usage.reasoningTokens !== undefined
            ? { reasoningTokens: result.usage.reasoningTokens }
            : {}),
          ...(result.usage.cachedTokens !== undefined
            ? { cachedTokens: result.usage.cachedTokens }
            : {}),
          recordedAt: endedAt,
        });

        if (this.opts.eventBus) {
          const event: OrchestratorEvent = {
            runId: request.runId,
            level: 'info',
            type: 'agent.usage',
            message: `${request.phaseId}: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens`,
            timestamp: endedAt.toISOString(),
            metadata: {
              phase: request.phaseId,
              phaseId: request.phaseId,
              profile: request.profile,
              provider: effectiveProvider,
              model: effectiveModel,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              ...(result.usage.reasoningTokens !== undefined
                ? { reasoningTokens: result.usage.reasoningTokens }
                : {}),
              ...(result.usage.cachedTokens !== undefined
                ? { cachedTokens: result.usage.cachedTokens }
                : {}),
              durationMs: result.durationMs,
            },
          };
          this.opts.eventBus.publish(request.runId, event);
        }
      } catch {
        // Non-critical: usage persistence failure should not prevent fallback
      }
    }

    // --- Adapter-level fallback only (caller-signalled is handled in invoke) ---
    // NOTE: The router does NOT consult PHASE_FALLBACKS here. The caller (bash script)
    // is responsible for passing --phase-id "fix-review-N" (not "whole-pr-fix-review-N")
    // for the whole-PR fix-review loop. If --phase-id naming ever changes to match
    // --phase, the router will need to consult PHASE_FALLBACKS for adapter-level fallback.
    const routingPhase = normalizeRoutingPhase(request.phaseId);
    if (!isFallbackOrCallerSignalled && this.shouldFallback(result, request.phaseId)) {
      let phaseEntry = this.opts.agent.phaseProfiles[routingPhase];
      if (!phaseEntry && routingPhase === 'arbiter') {
        phaseEntry =
          this.opts.agent.phaseProfiles['plan-design'] ??
          this.opts.agent.phaseProfiles['fix-review'];
      }
      const fallbackProfileName = phaseEntry?.fallbackProfile;
      if (fallbackProfileName) {
        const fallbackProfile = this.opts.agent.profiles[fallbackProfileName];
        if (fallbackProfile) {
          const fallbackAdapter = this.opts.adapters[fallbackProfile.runtime];
          if (fallbackAdapter) {
            const {
              reason: triggerReason,
              detail: triggerDetail,
              shortDetail: triggerShortDetail,
            } = this.determineTriggerReason(result);

            const { abortSignal: _abortSignal, ...rest } = request;
            const fallbackRequest: AgentInvocationRequest = {
              ...rest,
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
              triggerDetail,
              triggerShortDetail,
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

  private shouldFallback(result: AgentInvocationResult, phaseId: string): boolean {
    const isSerializationOutcome = isSerializationContractOutcome(result);
    if (isSerializationOutcome) return false;

    // NOTE: Does not consult PHASE_FALLBACKS — relies on caller passing a phaseId
    // whose normalized form exists in phaseProfiles. See comment in dispatch().
    const routingPhase = normalizeRoutingPhase(phaseId);
    let phaseEntry = this.opts.agent.phaseProfiles[routingPhase];
    if (!phaseEntry && routingPhase === 'arbiter') {
      phaseEntry =
        this.opts.agent.phaseProfiles['plan-design'] ?? this.opts.agent.phaseProfiles['fix-review'];
    }
    const triggers = (phaseEntry?.fallbackTriggers ?? [
      'timeout',
      'contract_violation',
      'runtime_error',
      'token_limit_exceeded',
      'quota_exceeded',
      'provider_error',
    ]) as string[];
    for (const trigger of triggers) {
      switch (trigger) {
        case 'timeout':
          if (result.outcome === 'timeout') return true;
          break;
        case 'contract_violation':
          if (result.outcome === 'contract_violation') return true;
          break;
        case 'missing_required_artifact':
          if (
            result.outcome === 'contract_violation' &&
            result.contractViolations.includes(CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT)
          )
            return true;
          break;
        case 'prompt_budget_exceeded':
          if (
            result.outcome === 'contract_violation' &&
            result.contractViolations.includes(CONTRACT_VIOLATION_CODES.PROMPT_BUDGET_EXCEEDED)
          )
            return true;
          break;
        case 'invalid_result_json':
          if (
            result.outcome === 'contract_violation' &&
            result.contractViolations.includes(CONTRACT_VIOLATION_CODES.INVALID_RESULT_JSON)
          )
            return true;
          break;
        case 'runtime_error':
          if (result.outcome === 'failed') return true;
          break;
        case 'token_limit_exceeded':
          if (result.outcome === 'failed' && isTokenLimitError(result) != null) return true;
          break;
        case 'quota_exceeded':
          if (result.outcome === 'failed' && isQuotaError(result) != null) return true;
          break;
        case 'provider_error':
          if (
            result.outcome === 'failed' &&
            (result.contractViolations.includes(CONTRACT_VIOLATION_CODES.PROVIDER_ERROR) ||
              isProviderError(result) != null)
          )
            return true;
          break;
      }
    }
    return false;
  }

  /** Determine the trigger reason for a fallback escalation.
   *  MUST only be called when `shouldFallback` has already returned `true`,
   *  because this function returns trigger reasons unconditionally for
   *  `outcome='failed'` without checking whether the trigger is actually
   *  configured in the phase's `fallbackTriggers` set. */
  private determineTriggerReason(result: AgentInvocationResult): TriggerClassification {
    if (result.outcome === 'timeout') return { reason: 'timeout' };
    if (result.outcome === 'contract_violation') {
      if (result.contractViolations.includes(CONTRACT_VIOLATION_CODES.PROMPT_BUDGET_EXCEEDED)) {
        return { reason: 'prompt_budget_exceeded' };
      }
      return { reason: 'contract_violation' };
    }
    if (result.outcome === 'failed') {
      const tokenDetail = isTokenLimitError(result);
      if (tokenDetail != null) {
        const res: TriggerClassification = {
          reason: 'token_limit_exceeded',
          detail: truncate(tokenDetail),
        };
        const short = tryParseOpenCodeError(tokenDetail);
        if (short) res.shortDetail = short;
        return res;
      }
      const quotaDetail = isQuotaError(result);
      if (quotaDetail != null) {
        const res: TriggerClassification = {
          reason: 'quota_exceeded',
          detail: truncate(quotaDetail),
        };
        const short = tryParseOpenCodeError(quotaDetail);
        if (short) res.shortDetail = short;
        return res;
      }
      const providerDetail = isProviderError(result);
      if (
        result.contractViolations.includes(CONTRACT_VIOLATION_CODES.PROVIDER_ERROR) ||
        providerDetail != null
      ) {
        const res: TriggerClassification = {
          reason: 'provider_error',
        };
        if (providerDetail) res.detail = truncate(providerDetail);
        const short = providerDetail ? tryParseOpenCodeError(providerDetail) : null;
        if (short) res.shortDetail = short;
        return res;
      }
      return { reason: 'runtime_error' };
    }
    return { reason: 'unknown' };
  }

  private effectiveProfile(p: { provider: string; model: string; variant?: string | undefined }): {
    provider: string;
    model: string;
  } {
    const envModel = this.env.AI_AGENT_MODEL?.trim();
    const baseModel = envModel || p.model;
    const effectiveModel = !envModel && p.variant ? `${baseModel}-${p.variant}` : baseModel;
    return {
      provider: this.env.AI_AGENT_PROVIDER?.trim() || p.provider,
      model: effectiveModel,
    };
  }

  private emitFallbackEvent(
    runId: string,
    fromProfile: string,
    toProfile: string,
    triggerReason: string,
    triggerOwner: string,
    triggerDetail?: string,
    shortDetail?: string,
  ): void {
    if (!this.opts.eventBus) return;
    const readableDetail = shortDetail ?? (triggerDetail ? `"${triggerDetail}"` : undefined);
    const detailMsg = readableDetail ? ` — ${readableDetail}` : '';
    const event: OrchestratorEvent = {
      runId,
      level: 'warn',
      type: 'phase.fallback.escalated',
      message: `Fallback from '${fromProfile}' to '${toProfile}' (reason: ${triggerReason}${detailMsg}, owner: ${triggerOwner})`,
      timestamp: this.clock().toISOString(),
      metadata: {
        fromProfile,
        toProfile,
        triggerReason,
        triggerOwner,
        ...(triggerDetail !== undefined ? { triggerDetail } : {}),
      },
    };
    this.opts.eventBus.publish(runId, event);
  }
}

/**
 * Strip per-invocation suffixes from a phase ID to get the key used in
 * `agent.phaseProfiles`. Bash emits IDs like `fix-review-1` (re-review loop
 * counter) and `quality-review-task-12` (per-task loop). Both must resolve
 * to their static config key (`fix-review`, `quality-review`).
 *
 * Exported for tests.
 */
export function normalizeRoutingPhase(phaseId: string): string {
  const normalized = phaseId.replace(/(-task)?-\d+$/, '');
  if (normalized === 'implement-final-review-arbiter' || normalized === 'plan-review-arbiter') {
    return 'arbiter';
  }
  return normalized;
}

function isTokenLimitError(result: AgentInvocationResult): string | null {
  try {
    const stderr = readFileSync(result.stderrPath, 'utf-8');
    return testTokenLimitPatterns(stderr, { maxLines: 2000 });
  } catch {
    return null;
  }
}

function isProviderError(result: AgentInvocationResult): string | null {
  try {
    const stderr = readFileSync(result.stderrPath, 'utf-8');
    return testProviderErrorPatterns(stderr, { maxLines: 2000 });
  } catch {
    return null;
  }
}

function isQuotaError(result: AgentInvocationResult): string | null {
  try {
    const stderr = readFileSync(result.stderrPath, 'utf-8');
    return testQuotaPatterns(stderr, { maxLines: 2000 });
  } catch {
    return null;
  }
}

function defaultReadPromptContent(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function readRetryIdentity(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  const camel = metadata.retryIdentity;
  if (typeof camel === 'string' && camel.length > 0) return camel;
  const snake = metadata.retry_identity;
  if (typeof snake === 'string' && snake.length > 0) return snake;
  return undefined;
}

function isSerializationContractOutcome(result: AgentInvocationResult): boolean {
  if (result.outcome !== 'contract_violation') return false;
  return (
    result.contractViolations.includes(CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT) ||
    result.contractViolations.includes(CONTRACT_VIOLATION_CODES.INVALID_RESULT_JSON) ||
    result.contractViolations.includes(CONTRACT_VIOLATION_CODES.NO_OUTPUT)
  );
}
