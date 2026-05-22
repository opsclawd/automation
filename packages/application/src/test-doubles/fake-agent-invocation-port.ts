import type {
  AgentInvocation,
  AgentInvocationId,
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
    this.rows[idx] = { ...this.rows[idx], ...patch } as unknown as AgentInvocation;
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
}
