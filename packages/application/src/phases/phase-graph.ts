import { type PhaseName, type ExecutionPolicy } from '@ai-sdlc/domain';
import {
  CANONICAL_PHASE_ORDER,
  resolvePhaseOrder,
  PHASE_DEFINITIONS,
  orderedPhases,
  type PhaseDefinition,
  InvalidSkipListError,
  UnknownPhaseError,
} from './phase-definitions.js';

export interface PhaseGraph {
  readonly policy: ExecutionPolicy;
  readonly scheduledPhases: readonly PhaseName[];
  isReachable(phaseName: string): boolean;
  getFirstIncompletePhase(input: {
    completedPhases: Set<string>;
    skippedPhases: Set<string>;
    skipSet: Set<string>;
  }): PhaseName | undefined;
  getNextPhase(current: PhaseName, skip?: PhaseName[]): PhaseName | null;
  getOrderedDefinitions(skip?: PhaseName[]): PhaseDefinition[];
}

class LegacyPhaseGraph implements PhaseGraph {
  readonly policy: ExecutionPolicy = 'legacy';
  readonly scheduledPhases: readonly PhaseName[] = CANONICAL_PHASE_ORDER;

  isReachable(phaseName: string): boolean {
    return this.scheduledPhases.includes(phaseName as PhaseName);
  }

  getFirstIncompletePhase(input: {
    completedPhases: Set<string>;
    skippedPhases: Set<string>;
    skipSet: Set<string>;
  }): PhaseName | undefined {
    for (const phaseName of this.scheduledPhases) {
      const nameStr = phaseName as string;
      if (
        !input.completedPhases.has(nameStr) &&
        !input.skippedPhases.has(nameStr) &&
        !input.skipSet.has(nameStr)
      ) {
        return phaseName;
      }
    }
    return undefined;
  }

  getNextPhase(current: PhaseName, skip: PhaseName[] = []): PhaseName | null {
    const order = orderedPhases(skip, PHASE_DEFINITIONS, 'legacy').map((p) => p.name);
    const idx = order.indexOf(current);
    if (idx === -1) {
      if (PHASE_DEFINITIONS[current]) {
        throw new InvalidSkipListError(
          `phase '${current}' is in the skip list and cannot be advanced from`,
        );
      }
      throw new UnknownPhaseError(current as string);
    }
    if (idx === order.length - 1) return null;
    return order[idx + 1]!;
  }

  getOrderedDefinitions(skip: PhaseName[] = []): PhaseDefinition[] {
    return orderedPhases(skip, PHASE_DEFINITIONS, 'legacy');
  }
}

class LeanPhaseGraph implements PhaseGraph {
  readonly scheduledPhases: readonly PhaseName[];

  constructor(readonly policy: 'standard' | 'strict') {
    this.scheduledPhases = resolvePhaseOrder(policy);
  }

  isReachable(phaseName: string): boolean {
    return this.scheduledPhases.includes(phaseName as PhaseName);
  }

  getFirstIncompletePhase(input: {
    completedPhases: Set<string>;
    skippedPhases: Set<string>;
    skipSet: Set<string>;
  }): PhaseName | undefined {
    // In lean phase graph, linear evaluation across scheduled phases:
    for (const phaseName of this.scheduledPhases) {
      const nameStr = phaseName as string;
      if (
        !input.completedPhases.has(nameStr) &&
        !input.skippedPhases.has(nameStr) &&
        !input.skipSet.has(nameStr)
      ) {
        return phaseName;
      }
    }
    return undefined;
  }

  getNextPhase(current: PhaseName, skip: PhaseName[] = []): PhaseName | null {
    const order = orderedPhases(skip, PHASE_DEFINITIONS, this.policy).map((p) => p.name);
    const idx = order.indexOf(current);
    if (idx === -1) {
      if (PHASE_DEFINITIONS[current]) {
        throw new InvalidSkipListError(
          `phase '${current}' is in the skip list and cannot be advanced from`,
        );
      }
      throw new UnknownPhaseError(current as string);
    }
    if (idx === order.length - 1) return null;
    return order[idx + 1]!;
  }

  getOrderedDefinitions(skip: PhaseName[] = []): PhaseDefinition[] {
    return orderedPhases(skip, PHASE_DEFINITIONS, this.policy);
  }
}

export function resolvePhaseGraph(policy?: ExecutionPolicy): PhaseGraph {
  const effectivePolicy = policy ?? 'legacy';
  if (effectivePolicy === 'standard' || effectivePolicy === 'strict') {
    return new LeanPhaseGraph(effectivePolicy);
  }
  return new LegacyPhaseGraph();
}
