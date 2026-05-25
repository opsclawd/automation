import type { AgentInvocation } from '@ai-sdlc/domain';
import { PHASE_RESULT_REGISTRY } from './phase-registry.js';
import type { ArtifactStore, AgentPort } from '../ports.js';
import { CONTRACT_VIOLATION_CODES } from '../agent/contract-violation-codes.js';
import type { AgentInvocationRequest } from '../agent/invocation.js';

export type ExtractResultOutcome<T = unknown> =
  | { ok: true; result: T }
  | {
      ok: false;
      reason: 'missing' | 'invalid';
      detail: string;
      violationCode: typeof CONTRACT_VIOLATION_CODES.INVALID_RESULT_JSON;
    };

export interface RerunContext {
  cwd: string;
  repoId: string;
}

export interface ExtractResultInput {
  invocation: AgentInvocation;
  ports: {
    artifacts: ArtifactStore;
    agent: AgentPort;
  };
  rerunContext?: RerunContext;
}

async function readAndValidate(
  runId: string,
  resultJsonPath: string | undefined,
  meta: { schema: import('zod').ZodTypeAny },
  ports: { artifacts: ArtifactStore },
): Promise<ExtractResultOutcome> {
  if (!resultJsonPath) {
    return {
      ok: false,
      reason: 'missing',
      detail: 'no resultJsonPath provided',
      violationCode: CONTRACT_VIOLATION_CODES.INVALID_RESULT_JSON,
    };
  }

  let raw: string;
  try {
    raw = await ports.artifacts.read(runId, resultJsonPath);
  } catch {
    return {
      ok: false,
      reason: 'missing',
      detail: `artifact not found: ${resultJsonPath} in run ${runId}`,
      violationCode: CONTRACT_VIOLATION_CODES.INVALID_RESULT_JSON,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      reason: 'invalid',
      detail: `JSON.parse failed: ${(e as Error).message}`,
      violationCode: CONTRACT_VIOLATION_CODES.INVALID_RESULT_JSON,
    };
  }

  const result = meta.schema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: 'invalid',
      detail: result.error.message,
      violationCode: CONTRACT_VIOLATION_CODES.INVALID_RESULT_JSON,
    };
  }

  return { ok: true, result: result.data };
}

function buildRetryRequest(invocation: AgentInvocation, ctx: RerunContext): AgentInvocationRequest {
  return {
    profile: invocation.profile,
    promptPath: invocation.promptPath,
    expectedArtifacts: ['result.json'],
    cwd: ctx.cwd,
    runId: invocation.runId as unknown as string,
    repoId: ctx.repoId,
    phaseId: invocation.phaseId as unknown as string,
    startCommitSha: invocation.startCommitSha,
    fallbackOfInvocationId: invocation.id,
    fallbackReason: CONTRACT_VIOLATION_CODES.INVALID_RESULT_JSON,
  };
}

export async function extractResult(input: ExtractResultInput): Promise<ExtractResultOutcome> {
  const { invocation, ports, rerunContext } = input;
  const meta = PHASE_RESULT_REGISTRY[invocation.phaseId as string];
  if (!meta) {
    throw new Error(`no result schema registered for phase '${invocation.phaseId}'`);
  }

  const runId = invocation.runId as unknown as string;
  const initial = await readAndValidate(runId, invocation.resultJsonPath, meta, ports);
  if (initial.ok) return initial;

  if (!meta.retrySafe || !invocation.resultJsonPath) {
    return initial;
  }

  if (!rerunContext) {
    return initial;
  }

  const rerunResult = await ports.agent.invoke(buildRetryRequest(invocation, rerunContext));

  return readAndValidate(runId, rerunResult.resultJsonPath, meta, ports);
}
