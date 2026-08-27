import type { GitFileChangeSummary } from '../ports/git-port.js';
import {
  classifyTaskChanges,
  findManifestTaskStakes,
  normalizeTaskPath,
  type ClassifyTaskChangesOptions,
  type EffectiveTaskScope,
  type ManifestTaskStake,
  type TaskChangeCandidate,
  type TaskScopeClassification,
} from '../task-file-boundaries.js';

export const MAX_TERMINAL_FIX_CHANGED_LINES = 10;
export const TERMINAL_FIX_SCOPE_POLICY = 'unowned_narrow_v1' as const;

export type TerminalFixRejectionReason =
  | 'categorical_boundary'
  | 'manifest_stake'
  | 'missing_summary'
  | 'ambiguous_summary'
  | 'non_narrow_summary'
  | 'reclassification_failed';

export interface TerminalFixCandidateEvidence {
  path: string;
  summary?: GitFileChangeSummary | undefined;
  stakes?: readonly ManifestTaskStake[] | undefined;
  classificationCategory?:
    | 'permitted'
    | 'drift'
    | 'protected'
    | 'non_goal'
    | 'modified_reference'
    | 'premature_implementation'
    | undefined;
}

export interface TerminalFixRejectionEvidence {
  reason: TerminalFixRejectionReason;
  path?: string | undefined;
  message: string;
  stakes?: readonly ManifestTaskStake[] | undefined;
  summary?: GitFileChangeSummary | undefined;
  summaries?: readonly GitFileChangeSummary[] | undefined;
  classification?: TaskScopeClassification | undefined;
}

export interface TerminalFixGrantedDecision {
  decision: 'grant';
  granted: true;
  policy: typeof TERMINAL_FIX_SCOPE_POLICY;
  grantedPaths: string[];
  overlayScope: EffectiveTaskScope;
  evidence: readonly TerminalFixCandidateEvidence[];
}

export interface TerminalFixRejectedDecision {
  decision: 'reject';
  granted: false;
  policy: typeof TERMINAL_FIX_SCOPE_POLICY;
  reason: TerminalFixRejectionReason;
  rejections: readonly TerminalFixRejectionEvidence[];
}

export type ReconcileTerminalFixScopeResult =
  | TerminalFixGrantedDecision
  | TerminalFixRejectedDecision;

export interface ReconcileTerminalFixScopeInput {
  candidates: readonly (string | TaskChangeCandidate)[];
  currentScope: EffectiveTaskScope;
  manifestTasks?: readonly unknown[] | undefined;
  tasks?: readonly unknown[] | undefined;
  manifest?: unknown;
  currentTaskNumber?: number | undefined;
  fileSummaries?: readonly GitFileChangeSummary[] | undefined;
  exemptFiles?: readonly string[] | undefined;
  isProtected?: ((path: string) => boolean) | undefined;
}

export function isNarrowGitFileChange(summary: GitFileChangeSummary | null | undefined): boolean {
  if (!summary || typeof summary !== 'object') {
    return false;
  }
  if (summary.binary) {
    return false;
  }
  if (summary.status !== 'modified') {
    return false;
  }
  if (
    typeof summary.additions !== 'number' ||
    !Number.isInteger(summary.additions) ||
    summary.additions < 0
  ) {
    return false;
  }
  if (
    typeof summary.deletions !== 'number' ||
    !Number.isInteger(summary.deletions) ||
    summary.deletions < 0
  ) {
    return false;
  }
  const totalChangedLines = summary.additions + summary.deletions;
  return totalChangedLines <= MAX_TERMINAL_FIX_CHANGED_LINES;
}

function buildClassifyOptions(
  input: ReconcileTerminalFixScopeInput,
  scope: EffectiveTaskScope,
): ClassifyTaskChangesOptions {
  const opts: ClassifyTaskChangesOptions = {
    candidates: input.candidates,
    currentScope: scope,
  };
  if (input.manifestTasks !== undefined) opts.manifestTasks = input.manifestTasks;
  if (input.tasks !== undefined) opts.tasks = input.tasks;
  if (input.manifest !== undefined) opts.manifest = input.manifest;
  if (input.currentTaskNumber !== undefined) opts.currentTaskNumber = input.currentTaskNumber;
  if (input.exemptFiles !== undefined) opts.exemptFiles = input.exemptFiles;
  if (input.isProtected !== undefined) opts.isProtected = input.isProtected;
  return opts;
}

export function reconcileTerminalFixScope(
  input: ReconcileTerminalFixScopeInput,
): ReconcileTerminalFixScopeResult {
  const normalizedCandidates: string[] = [];
  for (const raw of input.candidates ?? []) {
    const rawPath = typeof raw === 'string' ? raw : raw?.path;
    const norm = normalizeTaskPath(rawPath);
    if (norm && !normalizedCandidates.includes(norm)) {
      normalizedCandidates.push(norm);
    }
  }

  // If no candidates, grant with empty changes
  if (normalizedCandidates.length === 0) {
    const copiedScope: EffectiveTaskScope = {
      requiredFiles: [...(input.currentScope.requiredFiles ?? [])],
      mayExtendFiles: [...(input.currentScope.mayExtendFiles ?? [])],
      permittedAreas: [...(input.currentScope.permittedAreas ?? [])],
      nonGoals: [...(input.currentScope.nonGoals ?? [])],
      referenceFiles: [...(input.currentScope.referenceFiles ?? [])],
    };
    return {
      decision: 'grant',
      granted: true,
      policy: TERMINAL_FIX_SCOPE_POLICY,
      grantedPaths: [],
      overlayScope: copiedScope,
      evidence: [],
    };
  }

  const rejections: TerminalFixRejectionEvidence[] = [];

  // 1. Initial classification check
  const initialClassification = classifyTaskChanges(
    buildClassifyOptions(input, input.currentScope),
  );

  if (initialClassification.protectedFiles && initialClassification.protectedFiles.length > 0) {
    for (const path of initialClassification.protectedFiles) {
      rejections.push({
        reason: 'categorical_boundary',
        path,
        message: `Candidate file '${path}' is a protected file`,
        classification: initialClassification,
      });
    }
  }

  if (initialClassification.nonGoalFiles && initialClassification.nonGoalFiles.length > 0) {
    for (const path of initialClassification.nonGoalFiles) {
      rejections.push({
        reason: 'manifest_stake',
        path,
        message: `Candidate file '${path}' violates non-goal boundary`,
        classification: initialClassification,
      });
    }
  }

  if (
    initialClassification.modifiedReferenceFiles &&
    initialClassification.modifiedReferenceFiles.length > 0
  ) {
    for (const path of initialClassification.modifiedReferenceFiles) {
      rejections.push({
        reason: 'manifest_stake',
        path,
        message: `Candidate file '${path}' is a reference file`,
        classification: initialClassification,
      });
    }
  }

  if (
    initialClassification.prematureImplementation &&
    initialClassification.prematureImplementation.length > 0
  ) {
    for (const record of initialClassification.prematureImplementation) {
      rejections.push({
        reason: 'manifest_stake',
        path: record.path,
        message: `Candidate file '${record.path}' is claimed by downstream task ${record.taskNumber}`,
        classification: initialClassification,
      });
    }
  }

  // 2. Check manifest stakes across all manifest tasks
  const allTasks =
    input.manifestTasks ??
    input.tasks ??
    (input.manifest && typeof input.manifest === 'object' && 'tasks' in input.manifest
      ? (input.manifest as Record<string, unknown>).tasks
      : undefined);

  for (const path of normalizedCandidates) {
    const stakes = findManifestTaskStakes(path, allTasks as readonly unknown[] | undefined);
    if (stakes.length > 0) {
      rejections.push({
        reason: 'manifest_stake',
        path,
        stakes,
        message: `Candidate file '${path}' has manifest stakes: ${stakes
          .map((s) => `task ${s.taskNumber} (${s.field})`)
          .join(', ')}`,
      });
    }
  }

  // 3. Check git file summaries
  const summariesByPath = new Map<string, GitFileChangeSummary[]>();
  for (const summary of input.fileSummaries ?? []) {
    if (!summary || typeof summary.path !== 'string') continue;
    const norm = normalizeTaskPath(summary.path);
    if (!norm) continue;
    const list = summariesByPath.get(norm) ?? [];
    list.push(summary);
    summariesByPath.set(norm, list);
  }

  for (const path of normalizedCandidates) {
    const summaries = summariesByPath.get(path);
    if (!summaries || summaries.length === 0) {
      rejections.push({
        reason: 'missing_summary',
        path,
        message: `Missing git file change summary for candidate '${path}'`,
      });
    } else if (summaries.length > 1) {
      rejections.push({
        reason: 'ambiguous_summary',
        path,
        summaries,
        message: `Ambiguous multiple summaries (${summaries.length}) for candidate '${path}'`,
      });
    } else {
      const summary = summaries[0];
      if (summary && !isNarrowGitFileChange(summary)) {
        rejections.push({
          reason: 'non_narrow_summary',
          path,
          summary,
          message: `File change for '${path}' is not a narrow change (status: ${summary.status}, binary: ${summary.binary}, additions: ${summary.additions}, deletions: ${summary.deletions})`,
        });
      }
    }
  }

  // If there are rejections, fail atomically
  if (rejections.length > 0) {
    const reasonPriority: TerminalFixRejectionReason[] = [
      'categorical_boundary',
      'manifest_stake',
      'missing_summary',
      'ambiguous_summary',
      'non_narrow_summary',
      'reclassification_failed',
    ];
    let primaryReason: TerminalFixRejectionReason = rejections[0]?.reason ?? 'categorical_boundary';
    for (const priority of reasonPriority) {
      if (rejections.some((r) => r.reason === priority)) {
        primaryReason = priority;
        break;
      }
    }

    return {
      decision: 'reject',
      granted: false,
      policy: TERMINAL_FIX_SCOPE_POLICY,
      reason: primaryReason,
      rejections,
    };
  }

  // 4. Construct immutable overlay scope
  const overlayScope: EffectiveTaskScope = {
    requiredFiles: [...(input.currentScope.requiredFiles ?? [])],
    mayExtendFiles: [
      ...new Set([
        ...(input.currentScope.mayExtendFiles ?? []).map(normalizeTaskPath),
        ...normalizedCandidates,
      ]),
    ]
      .filter(Boolean)
      .sort(),
    permittedAreas: [...(input.currentScope.permittedAreas ?? [])],
    nonGoals: [...(input.currentScope.nonGoals ?? [])],
    referenceFiles: [...(input.currentScope.referenceFiles ?? [])],
  };

  // 5. Defensive reclassification
  const reclassification = classifyTaskChanges(buildClassifyOptions(input, overlayScope));

  if (
    reclassification.driftFiles.length > 0 ||
    (reclassification.protectedFiles && reclassification.protectedFiles.length > 0) ||
    reclassification.nonGoalFiles.length > 0 ||
    reclassification.modifiedReferenceFiles.length > 0 ||
    reclassification.prematureImplementation.length > 0
  ) {
    return {
      decision: 'reject',
      granted: false,
      policy: TERMINAL_FIX_SCOPE_POLICY,
      reason: 'reclassification_failed',
      rejections: [
        {
          reason: 'reclassification_failed',
          message:
            'Defensive reclassification with overlay scope failed to permit all candidate files',
          classification: reclassification,
        },
      ],
    };
  }

  // 6. Build granted decision with evidence
  const evidence: TerminalFixCandidateEvidence[] = normalizedCandidates.map((path) => {
    const summary = summariesByPath.get(path)?.[0];
    const item: TerminalFixCandidateEvidence = {
      path,
      classificationCategory: 'permitted',
    };
    if (summary !== undefined) {
      item.summary = summary;
    }
    return item;
  });

  return {
    decision: 'grant',
    granted: true,
    policy: TERMINAL_FIX_SCOPE_POLICY,
    grantedPaths: [...normalizedCandidates].sort(),
    overlayScope,
    evidence,
  };
}
