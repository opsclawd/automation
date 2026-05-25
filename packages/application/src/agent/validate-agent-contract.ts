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

  if (contract.allowedResultValues && invocation.resultJsonPath) {
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

  if (contract.mustNotChangeBranch) {
    const currentBranch = await ports.git.currentBranch(cwd);
    const currentSha = await ports.git.headCommitSha(cwd);
    const branchChanged =
      expectedBranch !== undefined
        ? currentBranch !== expectedBranch || currentSha !== invocation.startCommitSha
        : currentSha !== invocation.startCommitSha;
    if (branchChanged) {
      violations.push(CONTRACT_VIOLATION_CODES.BRANCH_CHANGED);
    }
  }

  if (contract.mustCreateCommit) {
    const endSha = invocation.endCommitSha ?? (await ports.git.headCommitSha(cwd));
    if (endSha === invocation.startCommitSha) {
      violations.push(CONTRACT_VIOLATION_CODES.MISSING_COMMIT);
    }
  }

  if (contract.mustPush) {
    const endSha = invocation.endCommitSha ?? (await ports.git.headCommitSha(cwd));
    const remoteSha = await ports.git.remoteRef({
      cwd,
      remote: contract.mustPush.remote,
      ref: contract.mustPush.ref,
    });
    if (remoteSha !== endSha) {
      violations.push(CONTRACT_VIOLATION_CODES.NOT_PUSHED);
    }
  }

  if (contract.mustPostReplies) {
    if (!repoFullName) {
      violations.push(CONTRACT_VIOLATION_CODES.REPLIES_NOT_POSTED);
    } else {
      const comments = await ports.github.listPrCommentsSince(
        repoFullName,
        contract.mustPostReplies.prNumber,
        invocation.startedAt.toISOString(),
      );
      if (comments.length === 0) {
        violations.push(CONTRACT_VIOLATION_CODES.REPLIES_NOT_POSTED);
      }
    }
  }

  return violations;
}
