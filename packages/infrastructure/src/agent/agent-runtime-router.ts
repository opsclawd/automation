import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import {
  AgentInvocationId,
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
} from '@ai-sdlc/application';
import { ConfigError, type AgentConfig } from '@ai-sdlc/shared';

export interface AgentRuntimeRouterOptions {
  agent: AgentConfig;
  adapters: Partial<Record<AgentRuntimeKind, AgentPort>>;
  invocationRepository: AgentInvocationPort;
  clock?: () => Date;
  idFactory?: () => string;
  readPromptChars?: (path: string) => number;
}

export class AgentRuntimeRouter implements AgentPort {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly readPromptChars: (path: string) => number;

  constructor(private readonly opts: AgentRuntimeRouterOptions) {
    this.clock = opts.clock ?? (() => new Date());
    this.idFactory = opts.idFactory ?? (() => randomUUID());
    this.readPromptChars = opts.readPromptChars ?? defaultReadPromptChars;
  }

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    const profile = this.opts.agent.profiles[request.profile];
    if (!profile) {
      throw new ConfigError(`unknown profile '${request.profile}'`);
    }
    const adapter = this.opts.adapters[profile.runtime];
    if (!adapter) {
      throw new ConfigError(`no adapter registered for runtime '${profile.runtime}'`);
    }

    const id = AgentInvocationId(this.idFactory());
    const startedAt = this.clock();
    const promptChars = this.readPromptChars(request.promptPath);
    const pre: AgentInvocation = {
      id,
      runId: RunId(request.runId),
      phaseId: PhaseName(request.phaseId),
      profile: request.profile,
      runtime: profile.runtime,
      provider: profile.provider,
      model: profile.model,
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
    this.opts.invocationRepository.insert(pre);

    let result: AgentInvocationResult;
    try {
      result = await adapter.invoke(request);
    } catch (err) {
      this.opts.invocationRepository.update(id, {
        endedAt: this.clock(),
        outcome: 'failed',
        contractViolations: [],
      });
      throw err;
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
    return result;
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
