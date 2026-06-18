import { type PhaseName, PhaseName as makePhaseName, type AgentContract } from '@ai-sdlc/domain';

export interface PhaseDefinition {
  name: PhaseName;
  inputs: { required: string[]; optional: string[] };
  outputs: string[];
  agentContract?: AgentContract;
  retrySafety: 'safe' | 'unsafe';
  skippable: boolean;
}

export class UnknownPhaseError extends Error {
  constructor(public readonly phase: string) {
    super(`unknown phase: '${phase}'`);
    this.name = 'UnknownPhaseError';
  }
}

export class InvalidSkipListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSkipListError';
  }
}

export class MissingRequiredInputError extends Error {
  constructor(
    public readonly phase: string,
    public readonly missing: string[],
  ) {
    super(`phase '${phase}' missing required inputs: ${missing.join(', ')}`);
    this.name = 'MissingRequiredInputError';
  }
}

// TODO: converge CANONICAL_PHASE_ORDER + PHASE_RESULT_REGISTRY into one source of truth
// Canonical names map to result registry keys via PHASE_NAME_MIGRATION_MAP in phase-registry.ts
export const CANONICAL_PHASE_ORDER: readonly PhaseName[] = [
  makePhaseName('read_issue'),
  makePhaseName('plan-design'),
  makePhaseName('plan-write'),
  makePhaseName('implement'),
  makePhaseName('validate'),
  makePhaseName('review-fix'),
  makePhaseName('compound'),
  makePhaseName('create-pr'),
  makePhaseName('pr-review-poll'),
];

const _phaseDefinitions = {
  read_issue: {
    name: makePhaseName('read_issue'),
    inputs: { required: [], optional: [] },
    outputs: ['issue.md', 'issue-comments.md'],
    retrySafety: 'safe',
    skippable: false,
  },
  'plan-design': {
    name: makePhaseName('plan-design'),
    inputs: { required: ['issue.md'], optional: ['issue-comments.md'] },
    outputs: ['design.md'],
    agentContract: { requiredArtifacts: ['design.md'], mustNotChangeBranch: true },
    retrySafety: 'safe',
    skippable: false,
  },
  'plan-write': {
    name: makePhaseName('plan-write'),
    inputs: { required: ['design.md'], optional: [] },
    outputs: ['plan.md'],
    agentContract: { requiredArtifacts: ['plan.md'], mustNotChangeBranch: true },
    retrySafety: 'safe',
    skippable: false,
  },
  implement: {
    name: makePhaseName('implement'),
    inputs: { required: ['plan.md'], optional: [] },
    outputs: ['implementation-log.md'],
    retrySafety: 'unsafe',
    skippable: false,
  },
  validate: {
    name: makePhaseName('validate'),
    inputs: { required: [], optional: ['implementation-log.md'] },
    outputs: ['validation-result.json'],
    retrySafety: 'safe',
    skippable: false,
  },
  'review-fix': {
    name: makePhaseName('review-fix'),
    // review.md consumed and produced in a loop — first iteration creates it,
    // subsequent iterations refine. The loop is optional.
    inputs: { required: [], optional: ['review.md'] },
    outputs: ['review.md', 'review-fix-log.md'],
    retrySafety: 'unsafe',
    skippable: false,
  },
  compound: {
    name: makePhaseName('compound'),
    inputs: { required: ['plan.md'], optional: ['design.md'] },
    outputs: ['compound.md'],
    agentContract: { requiredArtifacts: ['compound.md', 'result.json'], mustNotChangeBranch: true },
    retrySafety: 'unsafe',
    skippable: true,
  },
  'create-pr': {
    name: makePhaseName('create-pr'),
    inputs: { required: ['plan.md'], optional: ['compound.md'] },
    outputs: ['pr-summary.md', 'pr-url.txt'],
    agentContract: { requiredArtifacts: ['pr-summary.md'] },
    retrySafety: 'unsafe',
    skippable: false,
  },
  'pr-review-poll': {
    name: makePhaseName('pr-review-poll'),
    inputs: { required: ['pr-url.txt'], optional: [] },
    outputs: ['comments.json', 'reviews.json'],
    retrySafety: 'safe',
    skippable: false,
  },
} satisfies Record<string, PhaseDefinition>;

export const PHASE_DEFINITIONS: Record<PhaseName, PhaseDefinition> = _phaseDefinitions;

export function getPhaseDefinition(name: PhaseName): PhaseDefinition {
  const def = PHASE_DEFINITIONS[name];
  if (!def) throw new UnknownPhaseError(name as string);
  return def;
}

export function clonePhaseDefinitions(): Record<PhaseName, PhaseDefinition> {
  return structuredClone(PHASE_DEFINITIONS);
}

export function orderedPhases(
  skip: PhaseName[],
  definitions?: Record<PhaseName, PhaseDefinition>,
): PhaseDefinition[] {
  const defs = definitions ?? PHASE_DEFINITIONS;
  const skipSet = new Set(skip as string[]);

  for (const s of skipSet) {
    const def = defs[s as PhaseName];
    if (!def) throw new InvalidSkipListError(`unknown phase in skip list: '${s}'`);
    if (!def.skippable) throw new InvalidSkipListError(`phase '${s}' is not skippable`);
  }

  if (definitions) {
    const missing = CANONICAL_PHASE_ORDER.filter((n) => !skipSet.has(n as string) && !defs[n]);
    if (missing.length > 0) {
      throw new InvalidSkipListError(
        `custom definitions missing required phase(s): ${missing.join(', ')}`,
      );
    }
  }

  const kept = CANONICAL_PHASE_ORDER.filter((n) => !skipSet.has(n as string)).map((n) => defs[n]!);

  const producedByKept = new Set<string>();
  for (const def of kept) {
    for (const req of def.inputs.required) {
      if (!producedByKept.has(req)) {
        throw new InvalidSkipListError(
          `skipping orphans required input '${req}' needed by phase '${def.name}'`,
        );
      }
    }
    for (const out of def.outputs) producedByKept.add(out);
  }

  return kept;
}

export function nextPhase(current: PhaseName, skip: PhaseName[]): PhaseName | null {
  const order = orderedPhases(skip).map((p) => p.name);
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

export function assertInputsAvailable(phase: PhaseDefinition, present: string[]): void {
  const have = new Set(present);
  const missing = phase.inputs.required.filter((r) => !have.has(r));
  if (missing.length > 0) {
    throw new MissingRequiredInputError(phase.name as string, missing);
  }
}
