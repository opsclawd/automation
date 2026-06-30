import { PhaseName } from '@ai-sdlc/domain';
import type { RunRecord } from './ports.js';
import type { Phase } from '@ai-sdlc/domain';
import { getPhaseDefinition, CANONICAL_PHASE_ORDER } from './phases/index.js';

export type RecoveryAction = 'cancel' | 'retry' | 'resume';

export interface RecoveryPlan {
  action: RecoveryAction;
  allowed: boolean;
  statusCodeOnDenied: 409;
  denialReason?: string;
  targetPhase?: string;
  attempt?: number;
  retrySafety?: 'safe' | 'unsafe';
  requiresConfirmation: boolean;
}

export function planRunRecoveryAction(input: {
  action: RecoveryAction;
  run: RunRecord;
  phases: Phase[];
  fromPhase?: string;
}): RecoveryPlan {
  const { action, run, phases, fromPhase } = input;

  if (action === 'cancel') {
    const isTerminal =
      run.status === 'passed' || run.status === 'failed' || run.status === 'cancelled';
    if (isTerminal) {
      return {
        action: 'cancel',
        allowed: false,
        statusCodeOnDenied: 409,
        denialReason: `Cannot cancel a run in a terminal state (${run.status})`,
        requiresConfirmation: false,
      };
    }
    return {
      action: 'cancel',
      allowed: true,
      statusCodeOnDenied: 409,
      requiresConfirmation: false,
    };
  }

  if (action === 'retry') {
    if (run.status !== 'failed') {
      return {
        action: 'retry',
        allowed: false,
        statusCodeOnDenied: 409,
        denialReason: `Cannot retry a run that is not in failed state (status is '${run.status}')`,
        requiresConfirmation: false,
      };
    }

    let targetPhase = run.currentPhase;
    if (!targetPhase) {
      const failedPhases = phases.filter((p) => p.status === 'failed');
      if (failedPhases.length > 0) {
        failedPhases.sort((a, b) => {
          const timeA = a.completedAt ? a.completedAt.getTime() : 0;
          const timeB = b.completedAt ? b.completedAt.getTime() : 0;
          return timeB - timeA;
        });
        targetPhase = failedPhases[0]!.name;
      }
    }

    if (!targetPhase) {
      return {
        action: 'retry',
        allowed: false,
        statusCodeOnDenied: 409,
        denialReason: 'No current phase or failed phase found to retry',
        requiresConfirmation: false,
      };
    }

    const def = getPhaseDefinition(PhaseName(targetPhase));
    const failedAttemptsForTarget = phases
      .filter((p) => p.name === targetPhase && p.status === 'failed')
      .map((p) => p.attempt ?? 0);
    const maxAttempt =
      failedAttemptsForTarget.length > 0 ? Math.max(...failedAttemptsForTarget) : 0;
    const attempt = maxAttempt + 1;

    return {
      action: 'retry',
      allowed: true,
      statusCodeOnDenied: 409,
      targetPhase,
      attempt,
      retrySafety: def.retrySafety,
      requiresConfirmation: def.retrySafety === 'unsafe',
    };
  }

  if (action === 'resume') {
    if (run.status !== 'failed') {
      return {
        action: 'resume',
        allowed: false,
        statusCodeOnDenied: 409,
        denialReason: `Cannot resume a run that is not in failed state (status is '${run.status}')`,
        requiresConfirmation: false,
      };
    }

    let targetPhase: string | undefined;

    if (fromPhase) {
      // Validate through getPhaseDefinition; throws UnknownPhaseError if unknown
      getPhaseDefinition(PhaseName(fromPhase));
      targetPhase = fromPhase;
    } else {
      for (const name of CANONICAL_PHASE_ORDER) {
        if (!run.completedPhases.includes(name) && !run.skippedPhases.includes(name)) {
          targetPhase = name;
          break;
        }
      }
      if (!targetPhase) {
        targetPhase = run.currentPhase;
        if (!targetPhase) {
          const failedPhases = phases.filter((p) => p.status === 'failed');
          if (failedPhases.length > 0) {
            failedPhases.sort((a, b) => {
              const timeA = a.completedAt ? a.completedAt.getTime() : 0;
              const timeB = b.completedAt ? b.completedAt.getTime() : 0;
              return timeB - timeA;
            });
            targetPhase = failedPhases[0]!.name;
          }
        }
      }
    }

    if (!targetPhase) {
      return {
        action: 'resume',
        allowed: false,
        statusCodeOnDenied: 409,
        denialReason: 'No target phase found to resume',
        requiresConfirmation: false,
      };
    }

    const def = getPhaseDefinition(PhaseName(targetPhase));
    const failedAttemptsForTarget = phases
      .filter((p) => p.name === targetPhase && p.status === 'failed')
      .map((p) => p.attempt ?? 0);
    const maxAttempt =
      failedAttemptsForTarget.length > 0 ? Math.max(...failedAttemptsForTarget) : 0;
    const attempt = maxAttempt + 1;

    return {
      action: 'resume',
      allowed: true,
      statusCodeOnDenied: 409,
      targetPhase,
      attempt,
      retrySafety: def.retrySafety,
      requiresConfirmation: def.retrySafety === 'unsafe',
    };
  }

  // Fallback / unexpected action
  return {
    action,
    allowed: false,
    statusCodeOnDenied: 409,
    denialReason: `Unknown action: ${action}`,
    requiresConfirmation: false,
  };
}
