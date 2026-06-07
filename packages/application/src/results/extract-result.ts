import type { AgentInvocation } from '@ai-sdlc/domain';
import { PHASE_RESULT_REGISTRY } from './phase-registry.js';
import type { ArtifactStore, AgentPort } from '../ports.js';
import { ArtifactNotFoundError } from '../ports.js';
import { CONTRACT_VIOLATION_CODES } from '../ports/contract-violation-codes.js';
import type {
  AgentInvocationRequest,
  AgentInvocationResult,
} from '../ports/agent-invocation-types.js';

export type ExtractResultOutcome<T = unknown> =
  | { ok: true; result: T }
  | {
      ok: false;
      reason: 'missing' | 'invalid';
      detail: string;
      violationCode:
        | typeof CONTRACT_VIOLATION_CODES.INVALID_RESULT_JSON
        | typeof CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT
        | typeof CONTRACT_VIOLATION_CODES.ARTIFACT_READ_ERROR;
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
      violationCode: CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
    };
  }

  let raw: string;
  try {
    raw = await ports.artifacts.read(runId, resultJsonPath);
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof ArtifactNotFoundError ? 'missing' : 'invalid',
      detail: (e as Error)?.message ?? String(e),
      violationCode:
        e instanceof ArtifactNotFoundError
          ? CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT
          : CONTRACT_VIOLATION_CODES.ARTIFACT_READ_ERROR,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      reason: 'invalid',
      detail: `JSON.parse failed: ${(e as Error)?.message ?? String(e)}`,
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

function buildRetryRequest(
  invocation: AgentInvocation,
  ctx: RerunContext,
  fallbackReason: string,
): AgentInvocationRequest {
  return {
    profile: invocation.profile,
    promptPath: invocation.promptPath,
    expectedArtifacts: ['result.json'],
    cwd: ctx.cwd,
    runId: invocation.runId as unknown as string,
    repoId: ctx.repoId,
    phaseId: invocation.phaseId as unknown as string,
    ...(invocation.stepId ? { stepId: invocation.stepId } : {}),
    startCommitSha: invocation.startCommitSha,
    fallbackOfInvocationId: invocation.id,
    fallbackReason,
  };
}

export async function extractResult(input: ExtractResultInput): Promise<ExtractResultOutcome> {
  const { invocation, ports, rerunContext } = input;
  // Normalize dynamic phase IDs like "fix-validate-1" → "fix-validate"
  // so iteration-suffixed invocations resolve against the registry.
  const rawPhase = invocation.phaseId as string;
  const phase = rawPhase.replace(/-\d+$/, '');
  if (!Object.hasOwn(PHASE_RESULT_REGISTRY, phase)) {
    throw new Error(`no result schema registered for phase '${invocation.phaseId}'`);
  }
  const meta = PHASE_RESULT_REGISTRY[phase]!;

  const runId = invocation.runId as unknown as string;
  const initial = await readAndValidate(runId, invocation.resultJsonPath, meta, ports);
  if (initial.ok) return initial;

  if (!meta.retrySafe) {
    return initial;
  }

  // Skip rerun when initial invocation has no result path - deterministic failure
  // rather than burning tokens on LLM retry.
  if (!invocation.resultJsonPath || !rerunContext) {
    return initial;
  }

  let rerunResult: AgentInvocationResult;
  try {
    rerunResult = await ports.agent.invoke(
      buildRetryRequest(invocation, rerunContext, initial.violationCode),
    );
  } catch (e) {
    return {
      ok: false,
      reason: initial.reason,
      detail: `rerun invoke failed: ${(e as Error)?.message ?? String(e)}`,
      violationCode: initial.violationCode,
    };
  }

  return readAndValidate(runId, rerunResult.resultJsonPath, meta, ports);
}
