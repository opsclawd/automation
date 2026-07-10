import type { AgentPort } from '../ports/agent-port.js';
import type { AgentProfileName } from '../ports/agent-invocation-types.js';

export type VerifyCodeChangeFn = (input: {
  commentBody: string;
  path: string;
  line: number;
  cwd: string;
  startCommitSha: string;
  fixCommitSha: string;
  runId: string;
  repoId: string;
}) => Promise<{ pass: boolean; reason: string }>;

export interface VerifyCodeChangeDeps {
  agent: AgentPort;
  resolveProfileForPhase: (phaseName: string) => AgentProfileName;
  idFactory?: () => string;
  /** Builds the prompt file and returns its path + the dir to write result.json into.
   *  All filesystem IO (mkdirSync, writeFileSync) is the caller's responsibility. */
  renderVerifyPrompt: (input: {
    commentBody: string;
    path: string;
    line: number;
    cwd: string;
    startCommitSha: string;
    fixCommitSha: string;
  }) => Promise<{ promptPath: string; resultDir: string }>;
  /** Reads and parses result.json from the verifier agent's output directory.
   *  Returns null when the file is missing or unparseable. */
  extractVerifyResult: (input: {
    resultJsonPath?: string;
    resultDir: string;
  }) => Promise<{ pass: boolean; reason: string } | null>;
}

export function createVerifyCodeChange(deps: VerifyCodeChangeDeps): VerifyCodeChangeFn {
  return async (input) => {
    let profile: AgentProfileName;
    try {
      profile = deps.resolveProfileForPhase('verify-pr-review');
    } catch {
      return { pass: true, reason: 'verify-pr-review phase not configured; check skipped' };
    }

    const { promptPath, resultDir } = await deps.renderVerifyPrompt(input);

    let invocation;
    try {
      invocation = await deps.agent.invoke({
        profile,
        promptPath,
        expectedArtifacts: ['result.json'],
        cwd: resultDir,
        runId: input.runId,
        repoId: input.repoId,
        phaseId: 'verify-pr-review',
        startCommitSha: input.fixCommitSha,
        timeoutMs: 5 * 60_000,
        metadata: {
          pr_review_comment_id: (input as { commentId?: number }).commentId ?? 0,
          invocation_type: 'verifier',
        },
      });
    } catch {
      return { pass: false, reason: 'verifier agent invocation threw an exception' };
    }

    if (invocation.outcome !== 'success') {
      return {
        pass: false,
        reason: `verifier agent did not succeed (outcome: ${invocation.outcome})`,
      };
    }

    const result = await deps.extractVerifyResult({
      ...(invocation.resultJsonPath !== undefined
        ? { resultJsonPath: invocation.resultJsonPath }
        : {}),
      resultDir,
    });

    if (!result) {
      return { pass: false, reason: 'verifier result.json could not be parsed' };
    }
    return result;
  };
}
