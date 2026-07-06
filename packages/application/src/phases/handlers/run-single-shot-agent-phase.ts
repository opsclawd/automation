import { randomUUID } from 'node:crypto';
import type { AgentContract, AgentProfileName, Failure, PhaseName } from '@ai-sdlc/domain';
import type {
  AgentInvocationRequest,
  AgentInvocationResult,
} from '../../ports/agent-invocation-types.js';
import type { PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';
import { renderPrompt } from '../../prompts/render-prompt.js';
import { TemplateError, TemplateNotFoundError } from '../../prompts/errors.js';
import { validateAgentContract } from '../../agent/validate-agent-contract.js';
import { extractResult } from '../../results/extract-result.js';
import { AgentInvocationId, type AgentInvocation } from '@ai-sdlc/domain';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';
import type { ArtifactGuardPort } from '../../ports/git-port.js';

export interface SingleShotConfig {
  phase: PhaseName;
  profile: AgentProfileName;
  step: string;
  /** Injected prompt template (tests). When provided, skips loadPromptTemplate. */
  template?: string;
  vars: Record<string, string>;
  agentContract: AgentContract;
  /** Skip result extraction for phases where the agent drafts artifacts without
   *  producing a result.json (e.g. create-pr, where the result values like
   *  prNumber/prUrl are only known after the handler's deterministic steps). */
  skipResultExtraction?: boolean;
  cleanArtifacts?: boolean;
}

function assertField<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(
      `Missing required context field '${name}'. ` +
        `Agent phases require promptsRoot, startCommitSha, expectedBranch, and resolveProfile. ` +
    ...(ctx.modelOverride ? { model: ctx.modelOverride } : {}),
    ...(ctx.runtimeOverride ? { runtime: ctx.runtimeOverride } : {}),
        `These are populated by buildPhaseHandlerContext() in the compose root.`,
    );
  }
  if (typeof value === 'string' && value.trim() === '') {
    throw new Error(`Required context field '${name}' must not be empty.`);
  }
  return value;
}

function buildAgentInvocation(
  ctx: PhaseHandlerContext,
  config: SingleShotConfig,
  request: AgentInvocationRequest,
  result: AgentInvocationResult,
  promptChars: number,
  startedAt: Date,
  id: AgentInvocationId,
): AgentInvocation {
  const endedAt = ctx.now();

  return {
    id,
    runId: ctx.runUuid as AgentInvocation['runId'],
    phaseId: config.phase,
    profile: config.profile,
    runtime: result.runtime,
    provider: result.provider,
    model: result.model,
    promptPath: request.promptPath,
    promptChars,
    stdoutPath: result.stdoutPath,
    stderrPath: result.stderrPath,
    startedAt,
    endedAt,
    startCommitSha: request.startCommitSha,
    ...(ctx.modelOverride ? { model: ctx.modelOverride } : {}),
    ...(ctx.runtimeOverride ? { runtime: ctx.runtimeOverride } : {}),
    ...(result.endCommitSha ? { endCommitSha: result.endCommitSha } : {}),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timeoutMs: request.timeoutMs ?? 0,
    outcome: result.outcome,
    contractViolations: result.contractViolations,
    ...(result.resultJsonPath ? { resultJsonPath: result.resultJsonPath } : {}),
  };
}

function buildFailure(
  ctx: PhaseHandlerContext,
  phase: string,
  kind: Failure['kind'],
  message: string,
  canRetry: boolean,
  suggestedAction: string,
): Failure {
  return {
    runUuid: ctx.runUuid,
    phase,
    kind,
    message,
    canRetry,
    suggestedAction,
    artifacts: [],
    detectedAt: ctx.now(),
  };
}

export async function runSingleShotAgentPhase(
  ctx: PhaseHandlerContext,
  config: SingleShotConfig,
): Promise<PhaseResult> {
  const emit: EventEmitter = createEventEmitter(ctx, config.phase);

  // 1. Assert required optional context fields
  let promptsRoot: string | undefined;
  let startCommitSha: string;
  let expectedBranch: string;
  try {
    promptsRoot =
      config.template === undefined ? assertField(ctx.promptsRoot, 'promptsRoot') : undefined;
    startCommitSha = assertField(ctx.startCommitSha, 'startCommitSha');
    ...(ctx.modelOverride ? { model: ctx.modelOverride } : {}),
    ...(ctx.runtimeOverride ? { runtime: ctx.runtimeOverride } : {}),
    expectedBranch = assertField(ctx.expectedBranch, 'expectedBranch');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const failure = buildFailure(
      ctx,
      config.phase as string,
      'command_failed',
      message,
      false,
      'Ensure the compose root provides all required context fields.',
    );
    emit(`${String(config.phase)}.failed`, 'error', failure.message);
    return { outcome: 'failed', failure };
  }
  // 2. Load prompt template
  let template: string;
  if (config.template !== undefined) {
    template = config.template;
  } else {
    try {
      template = loadPromptTemplate(config.phase as string, config.step, {
        promptsRoot: promptsRoot!,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isMissing = e instanceof TemplateNotFoundError;
      const failure = buildFailure(
        ctx,
        config.phase as string,
        isMissing ? 'missing_artifact' : 'command_failed',
        `Failed to load prompt template: ${message}`,
        !isMissing,
        'Ensure the prompt template file exists at <promptsRoot>/<phase>/<step>.md.',
      );
      emit(`${String(config.phase)}.failed`, 'error', failure.message);
      return { outcome: 'failed', failure };
    }
  }

  // 3. Render prompt
  let renderedPrompt: string;
  try {
    renderedPrompt = await renderPrompt(template, {
      runId: ctx.runUuid,
      vars: config.vars,
      artifacts: ctx.artifacts,
    });
  } catch (e) {
    const kind: Failure['kind'] =
      e instanceof TemplateError && e.message.includes('missing artifact')
        ? 'missing_artifact'
        : 'command_failed';
    const message = e instanceof Error ? e.message : String(e);
    const failure = buildFailure(
      ctx,
      config.phase as string,
      kind,
      `Failed to render prompt: ${message}`,
      kind !== 'missing_artifact',
      'Ensure all required input artifacts exist in the artifact store.',
    );
    emit(`${String(config.phase)}.failed`, 'error', failure.message);
    return { outcome: 'failed', failure };
  }

  // 4. Write rendered prompt to artifact store
  const promptRelativePath = 'prompt.md';
  let promptAbsolutePath: string;
  try {
    const promptArtifact = await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: config.phase as string,
      relativePath: promptRelativePath,
      contents: renderedPrompt,
    });
    promptAbsolutePath = promptArtifact.absolutePath;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const failure = buildFailure(
      ctx,
      config.phase as string,
      'command_failed',
      `Failed to write prompt artifact: ${message}`,
      true,
      'Check disk space and permissions, then retry.',
    );
    emit(`${String(config.phase)}.failed`, 'error', failure.message);
    return { outcome: 'failed', failure };
  }
  emit('artifact.created', 'info', `wrote ${promptRelativePath}`, {
    path: promptRelativePath,
  });

  // 5. Build AgentInvocationRequest
  const request: AgentInvocationRequest = {
    profile: config.profile,
    promptPath: promptAbsolutePath,
    expectedArtifacts: config.agentContract.requiredArtifacts ?? [],
    cwd: ctx.cwd,
    runId: ctx.runUuid,
    repoId: ctx.repoFullName,
    phaseId: config.phase as string,
    startCommitSha,
    ...(ctx.modelOverride ? { model: ctx.modelOverride } : {}),
    ...(ctx.runtimeOverride ? { runtime: ctx.runtimeOverride } : {}),
  };

  // 6. Invoke agent
  const startedAt = ctx.now();
  const invocationId = AgentInvocationId(ctx.idFactory?.() || randomUUID());
  emit('agent.invoking', 'info', `invoking agent for ${config.phase}`, {
    profile: config.profile,
  });
  let agentResult: AgentInvocationResult;
  try {
    agentResult = await ctx.agent.invoke(request);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const failure = buildFailure(
      ctx,
      config.phase as string,
      'command_failed',
      `Agent invocation [${invocationId}] failed: ${message}`,
      true,
      'Check agent infrastructure configuration, then retry.',
    );
    emit(`${String(config.phase)}.failed`, 'error', failure.message);
    return { outcome: 'failed', failure };
  }

  // Emit remediation warnings if the runner auto-corrected misplaced artifacts
  if (agentResult.remediatedArtifacts?.length) {
    for (const r of agentResult.remediatedArtifacts) {
      emit(
        'artifact.remediated',
        'warn',
        `remediated misplaced artifact: ${r.src} → ${r.artifact}`,
        {
          src: r.src,
          artifact: r.artifact,
        },
      );
    }
  }

  if (agentResult.outcome !== 'success') {
    const failure = buildFailure(
      ctx,
      config.phase as string,
      agentResult.outcome === 'timeout' ? 'timeout' : 'command_failed',
      `Agent invocation [${invocationId}] failed with outcome '${agentResult.outcome}' (exit code ${agentResult.exitCode})`,
      true,
      'Check agent infrastructure and timeout settings, then retry.',
    );
    emit(`${String(config.phase)}.failed`, 'error', failure.message);
    return { outcome: 'failed', failure };
  }

  // 7. Build AgentInvocation domain object
  let invocation = buildAgentInvocation(
    ctx,
    config,
    request,
    agentResult,
    renderedPrompt.length,
    startedAt,
    invocationId,
  );

  // 8. Validate contract
  const violations = await validateAgentContract({
    contract: config.agentContract,
    invocation,
    ports: {
      artifacts: ctx.artifacts,
      git: ctx.git,
      github: ctx.github,
    },
    cwd: ctx.cwd,
    expectedBranch,
    repoFullName: ctx.repoFullName,
  });

  if (violations.length > 0) {
    const failure = buildFailure(
      ctx,
      config.phase as string,
      'agent_contract_violation',
      `Agent contract violations: ${violations.join(', ')}`,
      false,
      'Review agent output and contract requirements. The agent violated its instructions.',
    );
    emit(`${String(config.phase)}.blocked`, 'error', failure.message, { violations });
    return { outcome: 'blocked', failure };
  }

  // 9. Extract result (M4-05 single rerun handled internally)
  //    Skipped for phases where the agent produces draft artifacts only,
  //    and the result values are determined by handler-level operations.
  if (!config.skipResultExtraction) {
    const extracted = await extractResult({
      invocation,
      ports: {
        artifacts: ctx.artifacts,
        agent: ctx.agent,
      },
      rerunContext: {
        cwd: ctx.cwd,
        repoId: ctx.repoFullName,
      },
    });

    if (!extracted.ok) {
      const failure = buildFailure(
        ctx,
        config.phase as string,
        'invalid_result',
        `Result extraction failed: ${extracted.detail}`,
        false,
        'Review the agent output and result schema. The agent produced an invalid result.',
      );
      emit(`${String(config.phase)}.failed`, 'error', failure.message);
      return { outcome: 'failed', failure };
    }

    // If extractResult performed a rerun, forward the rerun's endCommitSha
    // and resultJsonPath into the invocation so post-extraction validation
    // checks the rerun's side effects, not the original run's stale data.
    if (extracted.rerunResult) {
      if (extracted.rerunResult.endCommitSha) {
        invocation = { ...invocation, endCommitSha: extracted.rerunResult.endCommitSha };
      }
      if (extracted.rerunResult.resultJsonPath) {
        invocation = { ...invocation, resultJsonPath: extracted.rerunResult.resultJsonPath };
      }
    }

    // Re-validate contract after extraction. extractResult may have
    // re-invoked the agent (M4-05 rerun), whose side effects (branch
    // change, deleted artifacts, etc.) would not have been caught by
    // the initial validation at step 8.
    const postExtractViolations = await validateAgentContract({
      contract: config.agentContract,
      invocation,
      ports: {
        artifacts: ctx.artifacts,
        git: ctx.git,
        github: ctx.github,
      },
      cwd: ctx.cwd,
      expectedBranch,
      repoFullName: ctx.repoFullName,
    });

    if (postExtractViolations.length > 0) {
      const failure = buildFailure(
        ctx,
        config.phase as string,
        'agent_contract_violation',
        `Agent contract violations (post-extraction): ${postExtractViolations.join(', ')}`,
        false,
        'Review agent output and contract requirements. The agent violated its instructions during rerun.',
      );
      emit(`${String(config.phase)}.blocked`, 'error', failure.message, {
        violations: postExtractViolations,
      });
      return { outcome: 'blocked', failure };
    }
  }

  // 10. Success
  // When skipResultExtraction is set, the parent handler performs additional
  // deterministic work (e.g. GitHub operations) before completion. Skip the
  // phase.completed emit so the parent handler's own emit captures the true
  // completion time including those side effects.
  if (!config.skipResultExtraction) {
    emit(`${String(config.phase)}.completed`, 'info', `${config.phase as string} completed`);
  }

  if (config.cleanArtifacts) {
    let validationResult: string | undefined;
    try {
      validationResult = await ctx.artifacts.read(ctx.runUuid, 'validation.result');
    } catch (err) {
      if (!(err instanceof ArtifactNotFoundError)) {
        throw err;
      }
    }

    try {
      const gitGuard = ctx.git as Partial<ArtifactGuardPort>;
      if (typeof gitGuard.cleanOrchestratorArtifacts === 'function') {
        await gitGuard.cleanOrchestratorArtifacts(ctx.cwd, ctx.baseBranch);
      }
    } finally {
      if (validationResult !== undefined && validationResult.trim() !== '') {
        await ctx.artifacts.write({
          runId: ctx.runUuid,
          phaseId: config.phase as string,
          relativePath: 'validation.result',
          contents: validationResult,
        });
      }
    }
  }

  return { outcome: 'passed' };
}
