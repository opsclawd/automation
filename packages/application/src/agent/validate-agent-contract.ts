import type { AgentContract, AgentInvocation } from '@ai-sdlc/domain';
import type { ArtifactStore, GitPort, GitHubPort } from '../ports.js';
import { CONTRACT_VIOLATION_CODES } from './contract-violation-codes.js';

export type ContractViolationCode =
  (typeof CONTRACT_VIOLATION_CODES)[keyof typeof CONTRACT_VIOLATION_CODES];

export interface ValidateAgentContractInput {
  contract: AgentContract;
  invocation: AgentInvocation;
  ports: {
    artifacts: ArtifactStore;
    git: GitPort;
    github: GitHubPort;
  };
  cwd: string;
  /** When mustPostReplies is set but repoFullName is omitted, REPO_NOT_PROVIDED is emitted
   *  because the validator cannot reach the GitHub API. Provide repoFullName to enable the check. */
  repoFullName?: string;
  expectedBranch?: string;
}

export async function validateAgentContract(
  input: ValidateAgentContractInput,
): Promise<ContractViolationCode[]> {
  const violations: ContractViolationCode[] = [];
  const { contract, invocation, ports, cwd, expectedBranch, repoFullName } = input;

  if (contract.requiredArtifacts) {
    for (const path of contract.requiredArtifacts) {
      try {
        const content = await ports.artifacts.read(invocation.runId, path);
        if (!content || content.trim().length === 0) {
          violations.push(CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT);
          break;
        }
      } catch {
        violations.push(CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT);
        break;
      }
    }
  }

  if (contract.allowedResultValues) {
    if (!invocation.resultJsonPath) {
      violations.push(CONTRACT_VIOLATION_CODES.INVALID_RESULT_VALUE);
    } else {
      try {
        const raw = await ports.artifacts.read(invocation.runId, invocation.resultJsonPath);
        const parsed = JSON.parse(raw) as { result?: string };
        if (!parsed.result || !contract.allowedResultValues.includes(parsed.result)) {
          violations.push(CONTRACT_VIOLATION_CODES.INVALID_RESULT_VALUE);
        }
      } catch {
        violations.push(CONTRACT_VIOLATION_CODES.INVALID_RESULT_VALUE);
      }
    }
  }

  if (contract.mustNotChangeBranch) {
    try {
      const currentBranch = await ports.git.currentBranch(cwd);
      const branchChanged =
        expectedBranch !== undefined
          ? currentBranch !== expectedBranch ||
            (await ports.git.headCommitSha(cwd)) !== invocation.startCommitSha
          : (await ports.git.headCommitSha(cwd)) !== invocation.startCommitSha;
      if (branchChanged) {
        violations.push(CONTRACT_VIOLATION_CODES.BRANCH_CHANGED);
      }
    } catch {
      violations.push(CONTRACT_VIOLATION_CODES.BRANCH_CHANGED);
    }
  }

  if (contract.mustCreateCommit) {
    try {
      const endSha = invocation.endCommitSha ?? (await ports.git.headCommitSha(cwd));
      if (endSha === invocation.startCommitSha) {
        violations.push(CONTRACT_VIOLATION_CODES.MISSING_COMMIT);
      }
    } catch {
      violations.push(CONTRACT_VIOLATION_CODES.MISSING_COMMIT);
    }
  }

  if (contract.mustPush) {
    try {
      const endSha = invocation.endCommitSha ?? (await ports.git.headCommitSha(cwd));
      const remoteSha = await ports.git.remoteRef({
        cwd,
        remote: contract.mustPush.remote,
        ref: contract.mustPush.ref,
      });
      if (remoteSha !== endSha) {
        violations.push(CONTRACT_VIOLATION_CODES.NOT_PUSHED);
      }
    } catch {
      violations.push(CONTRACT_VIOLATION_CODES.NOT_PUSHED);
    }
  }

  if (contract.mustPostReplies) {
    if (!repoFullName) {
      violations.push(CONTRACT_VIOLATION_CODES.REPO_NOT_PROVIDED);
    } else {
      try {
        const comments = await ports.github.listPrCommentsSince(
          repoFullName,
          contract.mustPostReplies.prNumber,
          invocation.startedAt.toISOString(),
        );
        if (comments.length === 0) {
          violations.push(CONTRACT_VIOLATION_CODES.REPLIES_NOT_POSTED);
        }
      } catch {
        violations.push(CONTRACT_VIOLATION_CODES.REPLIES_NOT_POSTED);
      }
    }
  }

  return violations;
}
