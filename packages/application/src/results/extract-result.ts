import type { AgentInvocation } from '@ai-sdlc/domain';
import { PHASE_RESULT_REGISTRY } from './phase-registry.js';
import type { ArtifactStore, AgentPort } from '../ports.js';
import { CONTRACT_VIOLATION_CODES } from '../agent/contract-violation-codes.js';

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

export async function extractResult(input: ExtractResultInput): Promise<ExtractResultOutcome> {
  const { invocation, ports } = input;
  const meta = PHASE_RESULT_REGISTRY[invocation.phaseId as string];
  if (!meta) {
    throw new Error(`no result schema registered for phase '${invocation.phaseId}'`);
  }

  if (!invocation.resultJsonPath) {
    return {
      ok: false,
      reason: 'missing',
      detail: `no resultJsonPath on invocation ${invocation.id}`,
      violationCode: CONTRACT_VIOLATION_CODES.INVALID_RESULT_JSON,
    };
  }

  let raw: string;
  try {
    raw = await ports.artifacts.read(
      invocation.runId as unknown as string,
      invocation.resultJsonPath,
    );
  } catch {
    return {
      ok: false,
      reason: 'missing',
      detail: `artifact not found: ${invocation.resultJsonPath} in run ${invocation.runId}`,
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
