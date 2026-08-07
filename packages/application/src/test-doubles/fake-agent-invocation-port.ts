import type {
  AgentInvocation,
  AgentInvocationId,
  AgentProfileName,
  AgentRuntimeKind,
  PhaseName,
  RunId,
} from '@ai-sdlc/domain';
import type {
  AgentInvocationPort,
  AgentInvocationUpdatePatch,
} from '../ports/agent-invocation-port.js';

export class FakeAgentInvocationPort implements AgentInvocationPort {
  private readonly rows: AgentInvocation[] = [];

  insert(invocation: AgentInvocation): void {
    this.rows.push({ ...invocation });
  }

  update(id: AgentInvocationId, patch: AgentInvocationUpdatePatch): void {
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`AgentInvocation ${id} not found`);
    const existing = this.rows[idx]!;
    const mergedMetadata =
      patch.metadata !== undefined
        ? { ...(existing.metadata ?? {}), ...patch.metadata }
        : existing.metadata;
    this.rows[idx] = {
      ...existing,
      ...patch,
      ...(mergedMetadata ? { metadata: mergedMetadata } : {}),
    } as unknown as AgentInvocation;
  }

  findById(id: AgentInvocationId): AgentInvocation | undefined {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : undefined;
  }

  listByRun(runId: RunId): AgentInvocation[] {
    return this.rows.filter((r) => r.runId === runId).map((r) => ({ ...r }));
  }

  listByRunAndPhase(runId: RunId, phaseId: PhaseName): AgentInvocation[] {
    return this.rows
      .filter((r) => r.runId === runId && r.phaseId === phaseId)
      .map((r) => ({ ...r }));
  }

  listByRuntime(runtime: AgentRuntimeKind): AgentInvocation[] {
    return this.rows.filter((r) => r.runtime === runtime).map((r) => ({ ...r }));
  }

  countConsecutiveProviderFailures(profile: AgentProfileName): number {
    const completedProfileRows = this.rows.filter(
      (r) => r.profile === profile && r.endedAt !== undefined,
    );

    completedProfileRows.sort((a, b) => {
      const timeA = a.startedAt.getTime();
      const timeB = b.startedAt.getTime();
      if (timeA !== timeB) {
        return timeB - timeA;
      }
      return b.id.localeCompare(a.id);
    });

    let count = 0;
    for (const row of completedProfileRows) {
      const isProviderFailure =
        row.outcome === 'failed' && row.contractViolations?.includes('provider_error');

      if (isProviderFailure) {
        count++;
      } else {
        break;
      }
    }

    return count;
  }
}
