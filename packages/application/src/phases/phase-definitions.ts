import { type PhaseName, type AgentContract } from '@ai-sdlc/domain';

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

export const CANONICAL_PHASE_ORDER: readonly PhaseName[] = [
  'read_issue' as PhaseName,
  'plan-design' as PhaseName,
  'plan-write' as PhaseName,
  'implement' as PhaseName,
  'validate' as PhaseName,
  'review-fix' as PhaseName,
  'compound' as PhaseName,
  'create-pr' as PhaseName,
  'pr-review-poll' as PhaseName,
];

const _p = (name: string): PhaseName => name as PhaseName;

export const PHASE_DEFINITIONS: Record<PhaseName, PhaseDefinition> = {
  read_issue: {
    name: _p('read_issue'),
    inputs: { required: [], optional: [] },
    outputs: ['issue.md', 'issue-comments.md'],
    retrySafety: 'safe',
    skippable: false,
  },
  'plan-design': {
    name: _p('plan-design'),
    inputs: { required: ['issue.md'], optional: ['issue-comments.md'] },
    outputs: ['design.md'],
    agentContract: { requiredArtifacts: ['design.md'], mustNotChangeBranch: true },
    retrySafety: 'safe',
    skippable: false,
  },
  'plan-write': {
    name: _p('plan-write'),
    inputs: { required: ['design.md'], optional: [] },
    outputs: ['plan.md'],
    agentContract: { requiredArtifacts: ['plan.md'], mustNotChangeBranch: true },
    retrySafety: 'safe',
    skippable: false,
  },
  implement: {
    name: _p('implement'),
    inputs: { required: ['plan.md'], optional: [] },
    outputs: ['implementation-log.md'],
    retrySafety: 'safe',
    skippable: false,
  },
  validate: {
    name: _p('validate'),
    inputs: { required: [], optional: [] },
    outputs: ['validation-result.json'],
    retrySafety: 'safe',
    skippable: false,
  },
  'review-fix': {
    name: _p('review-fix'),
    inputs: { required: [], optional: ['review.md'] },
    outputs: ['review.md', 'review-fix-log.md'],
    retrySafety: 'safe',
    skippable: false,
  },
  compound: {
    name: _p('compound'),
    inputs: { required: ['plan.md'], optional: ['design.md'] },
    outputs: ['compound.md'],
    agentContract: { requiredArtifacts: ['compound.md'], mustNotChangeBranch: true },
    retrySafety: 'safe',
    skippable: true,
  },
  'create-pr': {
    name: _p('create-pr'),
    inputs: { required: ['plan.md'], optional: ['compound.md'] },
    outputs: ['pr-summary.md', 'pr-url.txt'],
    agentContract: { requiredArtifacts: ['pr-summary.md'] },
    retrySafety: 'unsafe',
    skippable: false,
  },
  'pr-review-poll': {
    name: _p('pr-review-poll'),
    inputs: { required: ['pr-url.txt'], optional: [] },
    outputs: ['comments.json', 'reviews.json'],
    retrySafety: 'safe',
    skippable: false,
  },
} as Record<PhaseName, PhaseDefinition>;

export function getPhaseDefinition(name: PhaseName): PhaseDefinition {
  const def = PHASE_DEFINITIONS[name];
  if (!def) throw new UnknownPhaseError(name as string);
  return def;
}

export function orderedPhases(skip: PhaseName[]): PhaseDefinition[] {
  const skipSet = new Set(skip as string[]);

  for (const s of skipSet) {
    const def = PHASE_DEFINITIONS[s as PhaseName];
    if (!def) throw new InvalidSkipListError(`unknown phase in skip list: '${s}'`);
    if (!def.skippable) throw new InvalidSkipListError(`phase '${s}' is not skippable`);
  }

  const kept = CANONICAL_PHASE_ORDER.filter((n) => !skipSet.has(n as string)).map(
    (n) => PHASE_DEFINITIONS[n]!,
  );

  const producedByKept = new Set<string>();
  for (const def of kept) {
    for (const req of def.inputs.required) {
      if (!producedByKept.has(req)) {
        const anyKeptProduces = kept.some((d) => d.outputs.includes(req));
        if (!anyKeptProduces) {
          throw new InvalidSkipListError(
            `skipping orphans required input '${req}' needed by phase '${def.name}'`,
          );
        }
      }
    }
    for (const out of def.outputs) producedByKept.add(out);
  }

  return kept;
}

export function nextPhase(current: PhaseName, skip: PhaseName[]): PhaseName | null {
  const order = orderedPhases(skip).map((p) => p.name);
  const idx = order.indexOf(current);
  if (idx === -1 || idx === order.length - 1) return null;
  return order[idx + 1]!;
}

export function assertInputsAvailable(phase: PhaseDefinition, present: string[]): void {
  const have = new Set(present);
  const missing = phase.inputs.required.filter((r) => !have.has(r));
  if (missing.length > 0) {
    throw new MissingRequiredInputError(phase.name as string, missing);
  }
}
