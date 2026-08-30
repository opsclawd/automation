import type { AgentInvocation, AgentInvocationId } from '@ai-sdlc/domain';
import {
  getPhaseResultMeta,
  normalizePhaseId,
  type PhaseResultMeta,
  type PhaseResultRegistryMap,
  type RegisteredPhase,
} from './phase-registry.js';
import type { ArtifactStore, StructuredResultRepairPort } from '../ports.js';
import { ArtifactNotFoundError } from '../ports.js';
import { CONTRACT_VIOLATION_CODES } from '../ports/contract-violation-codes.js';
import { hasEvidence } from './failure-classification.js';
import { parseAgentResultJson } from './parse-agent-json.js';

export type ExtractResultOutcome<T = unknown> =
  | { ok: true; result: T; repairInvocationId?: AgentInvocationId }
  | {
      ok: false;
      classification: 'serialization_artifact' | 'unrecoverable_artifact';
      reason: 'missing' | 'invalid';
      detail: string;
      violationCode:
        | typeof CONTRACT_VIOLATION_CODES.INVALID_RESULT_JSON
        | typeof CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT
        | typeof CONTRACT_VIOLATION_CODES.ARTIFACT_READ_ERROR;
    };

export interface ExtractResultInputWithMeta<T> {
  invocation: AgentInvocation;
  ports: {
    artifacts: ArtifactStore;
    repair?: StructuredResultRepairPort | undefined;
    agent?: unknown;
  };
  cwd?: string | undefined;
  rerunContext?: { cwd: string; [key: string]: unknown } | undefined;
  repairExpectedHead?: string | undefined;
  transcriptEvidence?: string | undefined;
  resultMeta: PhaseResultMeta<T>;
}

export interface ExtractResultInputFromRegistry<_P extends RegisteredPhase = RegisteredPhase> {
  invocation: AgentInvocation;
  ports: {
    artifacts: ArtifactStore;
    repair?: StructuredResultRepairPort | undefined;
    agent?: unknown;
  };
  cwd?: string | undefined;
  rerunContext?: { cwd: string; [key: string]: unknown } | undefined;
  repairExpectedHead?: string | undefined;
  transcriptEvidence?: string | undefined;
  resultMeta?: undefined;
}

export type ExtractResultInput<T = unknown> =
  | ExtractResultInputWithMeta<T>
  | ExtractResultInputFromRegistry;

async function readAndValidate(
  runId: string,
  resultJsonPath: string | undefined,
  meta: PhaseResultMeta<unknown>,
  ports: { artifacts: ArtifactStore },
): Promise<
  | { ok: true; result: unknown }
  | {
      ok: false;
      reason: 'missing' | 'invalid';
      detail: string;
      violationCode:
        | typeof CONTRACT_VIOLATION_CODES.INVALID_RESULT_JSON
        | typeof CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT
        | typeof CONTRACT_VIOLATION_CODES.ARTIFACT_READ_ERROR;
    }
> {
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
    parsed = parseAgentResultJson(raw);
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

export async function extractResult<T>(
  input: ExtractResultInputWithMeta<T>,
): Promise<ExtractResultOutcome<T>>;
export async function extractResult<P extends RegisteredPhase>(
  input: ExtractResultInputFromRegistry<P>,
): Promise<ExtractResultOutcome<PhaseResultRegistryMap[P]>>;
export async function extractResult(
  input: ExtractResultInputFromRegistry,
): Promise<ExtractResultOutcome<unknown>>;
export async function extractResult(
  input: ExtractResultInput<unknown>,
): Promise<ExtractResultOutcome<unknown>> {
  const { invocation, ports, resultMeta } = input;
  const rawPhase = invocation.phaseId as string;
  const phase = normalizePhaseId(rawPhase);

  let meta: PhaseResultMeta<unknown>;
  if (resultMeta) {
    meta = resultMeta;
  } else {
    const registryMeta = getPhaseResultMeta(phase);
    if (!registryMeta) {
      throw new Error(`no result schema registered for phase '${invocation.phaseId}'`);
    }
    meta = registryMeta;
  }

  const runId = invocation.runId as unknown as string;
  const initial = await readAndValidate(runId, invocation.resultJsonPath, meta, ports);
  if (initial.ok) {
    return initial as ExtractResultOutcome<unknown>;
  }

  const hasEv = hasEvidence(invocation.stdoutPath);
  const initialClassification = hasEv ? 'serialization_artifact' : 'unrecoverable_artifact';

  if (initialClassification === 'unrecoverable_artifact' || !ports.repair) {
    return {
      ...initial,
      classification: initialClassification,
    };
  }

  // We have evidence and ports.repair is available: perform repair.
  let rawText = '';
  if (invocation.resultJsonPath) {
    try {
      rawText = await ports.artifacts.read(runId, invocation.resultJsonPath);
    } catch {
      // Ignore
    }
  }

  const cwd = input.cwd ?? input.rerunContext?.cwd ?? '';
  const repairResult = await ports.repair.repairStructuredResult({
    runId,
    cwd,
    normalizedPhase: phase,
    destination: invocation.resultJsonPath || 'result.json',
    schemaContractText: meta.schemaContractText,
    cappedRawArtifact: rawText,
    transcriptEvidence: input.transcriptEvidence ?? '',
    expectedHead: input.repairExpectedHead ?? invocation.endCommitSha ?? invocation.startCommitSha,
    classification: initial.violationCode,
    primaryInvocation: {
      id: invocation.id,
      stdoutPath: invocation.stdoutPath,
      stderrPath: invocation.stderrPath,
    },
  });

  if (repairResult.outcome === 'repaired') {
    const repaired = await readAndValidate(runId, invocation.resultJsonPath, meta, ports);
    if (repaired.ok) {
      return {
        ok: true,
        result: repaired.result,
        ...(repairResult.repairInvocationId
          ? { repairInvocationId: repairResult.repairInvocationId }
          : {}),
      };
    }
  }

  return {
    ...initial,
    classification: initialClassification,
  };
}
