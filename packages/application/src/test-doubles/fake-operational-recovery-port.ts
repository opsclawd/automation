import type {
  OperationalRecoveryPort,
  OperationalRecoveryInspection,
  CommitLeaseReclamationInput,
  ReclaimExpiredClaimInput,
  LeaseReclamationResult,
} from '../ports/operational-recovery-port.js';
import type { RepositoryId } from '@ai-sdlc/domain';

export class FakeOperationalRecoveryPort implements OperationalRecoveryPort {
  inspections = new Map<string, OperationalRecoveryInspection>();
  reclaimExpiredClaimResults = new Map<string, LeaseReclamationResult>();
  commitLeaseReclamationResults = new Map<string, LeaseReclamationResult>();

  inspectCalls: { repoId: RepositoryId; now: Date }[] = [];
  reclaimExpiredClaimCalls: ReclaimExpiredClaimInput[] = [];
  commitLeaseReclamationCalls: CommitLeaseReclamationInput[] = [];

  inspect(repoId: RepositoryId, now: Date): OperationalRecoveryInspection {
    this.inspectCalls.push({ repoId, now });
    const match = this.inspections.get(repoId);
    if (match) {
      return match;
    }
    return {
      repoId,
      hasActiveLease: false,
      hasActiveJob: false,
    };
  }

  reclaimExpiredClaim(input: ReclaimExpiredClaimInput): LeaseReclamationResult {
    this.reclaimExpiredClaimCalls.push(input);
    const key = `${input.repoId}:${input.runId}`;
    const result =
      this.reclaimExpiredClaimResults.get(key) ?? this.reclaimExpiredClaimResults.get('*');
    if (result) {
      return result;
    }
    return { committed: true };
  }

  commitLeaseReclamation(input: CommitLeaseReclamationInput): LeaseReclamationResult {
    this.commitLeaseReclamationCalls.push(input);
    const key = `${input.repoId}:${input.runId}`;
    const result =
      this.commitLeaseReclamationResults.get(key) ?? this.commitLeaseReclamationResults.get('*');
    if (result) {
      return result;
    }
    return { committed: true };
  }
}
