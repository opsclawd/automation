import type { AgentInvocation, AgentInvocationId } from '@ai-sdlc/domain';
import { PHASE_RESULT_REGISTRY, normalizePhaseId, type PhaseResultMeta } from './phase-registry.js';
import type { ArtifactStore, StructuredResultRepairPort } from '../ports.js';
import { ArtifactNotFoundError } from '../ports.js';
import { CONTRACT_VIOLATION_CODES } from '../ports/contract-violation-codes.js';
import { hasEvidence } from './failure-classification.js';

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

export interface ExtractResultInput {
  invocation: AgentInvocation;
  ports: {
    artifacts: ArtifactStore;
    repair?: StructuredResultRepairPort | undefined;
    agent?: unknown;
  };
  cwd?: string | undefined;
  rerunContext?: { cwd: string; [key: string]: unknown } | undefined;
}

async function readAndValidate(
  runId: string,
  resultJsonPath: string | undefined,
  meta: PhaseResultMeta,
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

export async function extractResult(input: ExtractResultInput): Promise<ExtractResultOutcome> {
  const { invocation, ports } = input;
  const rawPhase = invocation.phaseId as string;
  const phase = normalizePhaseId(rawPhase);
  if (!Object.hasOwn(PHASE_RESULT_REGISTRY, phase)) {
    throw new Error(`no result schema registered for phase '${invocation.phaseId}'`);
  }
  const meta = PHASE_RESULT_REGISTRY[phase]!;

  const runId = invocation.runId as unknown as string;
  const initial = await readAndValidate(runId, invocation.resultJsonPath, meta, ports);
  if (initial.ok) {
    return initial;
  }

  const hasEv = hasEvidence(invocation.stdoutPath);
  const classification = hasEv ? 'serialization_artifact' : 'unrecoverable_artifact';

  if (classification === 'unrecoverable_artifact' || !ports.repair) {
    return {
      ...initial,
      classification,
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
    transcriptEvidence: '',
    expectedHead: invocation.startCommitSha,
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
    classification: 'unrecoverable_artifact',
  };
}
