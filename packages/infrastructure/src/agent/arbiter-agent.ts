import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentProfileName, AgentInvocationId } from '@ai-sdlc/domain';
import {
  ArtifactNotFoundError,
  type StepLoopContext,
  type TypecheckResult,
  type FixResult,
  type ArbiterResult,
  type ArtifactStore,
  type AgentPort,
  type AgentInvocationPort,
  extractResult,
} from '@ai-sdlc/application';

export interface ArbiterAgentDeps {
  agent: AgentPort;
  artifacts: (runId: string, cwd: string) => ArtifactStore;
  invocations: AgentInvocationPort;
  baseTmpDir: string;
  resolveStartCommitSha: (cwd: string, runId: string) => string;
  newestInvocationId: (runId: string) => string;
}

export function buildArbiterPrompt(
  ctx: StepLoopContext,
  tcResult: TypecheckResult,
  specReviewMarkdown: string,
  qualityReviewMarkdown: string,
  fixResult: FixResult,
  issueExcerpt: string,
  historyContext?: string,
): string {
  const sections = [
    '# ARBITER TASK',
    `Arbitrate a review/fix contradiction for step ${ctx.stepIndex}: ${ctx.stepTitle}`,
    '',
    '## CONTEXT',
    `Working directory: ${ctx.cwd}`,
    `Iteration: ${ctx.iterationIndex}`,
    '',
    '### Issue Excerpt',
    '```',
    issueExcerpt,
    '```',
    '',
  ];

  if (historyContext) {
    sections.push('### Review/Fix History', historyContext, '');
  }

  sections.push(
    '### Typecheck Result',
    tcResult.outcome === 'pass' ? 'PASS' : `FAIL\n\n${tcResult.output}`,
    '',
    '### Spec Review Findings',
    specReviewMarkdown || '(no findings recorded)',
    '',
    '### Quality Review Findings',
    qualityReviewMarkdown || '(no findings recorded)',
    '',
    '### Fixer Rebuttal',
    fixResult.rebuttal || '(no rebuttal provided)',
    '',
    '## YOUR JOB',
    'You are a senior architect arbitrating between a reviewer (who found defects) and a fixer (who claims no fix is needed or that the reviewer is wrong).',
    '',
    'Evaluate the evidence strictly. Is the reviewer finding technically valid based on the requirements and the current code state?',
    '',
    'Possible outcomes:',
    '- `finding_valid`: The reviewer is correct. The fixer must apply the fix.',
    '- `finding_invalid`: The reviewer is incorrect. The fixer is right to skip.',
    '- `ambiguous`: The requirements or code state are too vague to decide.',
    '- `insufficient_evidence`: You cannot verify the finding with the provided context.',
    '',
    '## OUTPUT',
    `Write result.json to ${join(ctx.cwd, 'result.json')}:`,
    '```json',
    '{',
    '  "outcome": "finding_valid" | "finding_invalid" | "ambiguous" | "insufficient_evidence",',
    '  "defect_classification": "<optional category>",',
    '  "evidence": "<detailed technical evidence from code>",',
    '  "rationale": "<your full reasoning for the ruling>"',
    '}',
    '```',
    '',
    '## STOP RULE',
    'After writing result.json, stop immediately.',
  );

  return sections.join('\n');
}

export class ArbiterAgent {
  constructor(private readonly deps: ArbiterAgentDeps) {}

  async runArbiter(
    ctx: StepLoopContext,
    tcResult: TypecheckResult,
    fixResult: FixResult,
    options: {
      profile: AgentProfileName;
      historyContext?: string;
    },
  ): Promise<ArbiterResult> {
    const { deps } = this;
    const artifacts = deps.artifacts(ctx.runId, ctx.cwd);

    let specReviewMarkdown = '';
    try {
      specReviewMarkdown = await artifacts.read(ctx.runId, 'code-review.md');
    } catch (err) {
      if (!(err instanceof ArtifactNotFoundError)) throw err;
    }

    // Quality review artifacts might be separate or merged.
    const qualityReviewMarkdown = '';

    let issueExcerpt = '';
    try {
      const issueMd = await artifacts.read(ctx.runId, 'issue.md');
      issueExcerpt = issueMd.split('\n').slice(0, 100).join('\n');
    } catch (err) {
      if (!(err instanceof ArtifactNotFoundError)) throw err;
    }

    const promptDir = join(deps.baseTmpDir, 'arbiter-prompts');
    if (!existsSync(promptDir)) {
      mkdirSync(promptDir, { recursive: true });
    }
    const promptPath = join(
      promptDir,
      `arbiter-${ctx.runId}-${ctx.stepIndex}-${ctx.iterationIndex}.md`,
    );

    const prompt = buildArbiterPrompt(
      ctx,
      tcResult,
      specReviewMarkdown,
      qualityReviewMarkdown,
      fixResult,
      issueExcerpt,
      options.historyContext,
    );
    writeFileSync(promptPath, prompt, 'utf-8');

    const startCommitSha = deps.resolveStartCommitSha(ctx.cwd, ctx.runId);

    await deps.agent.invoke({
      profile: options.profile,
      promptPath,
      expectedArtifacts: ['result.json'],
      cwd: ctx.cwd,
      runId: ctx.runId,
      repoId: ctx.repoId,
      phaseId: 'arbitrate',
      startCommitSha,
    });

    const invId = deps.newestInvocationId(ctx.runId);
    const inv = deps.invocations.findById(AgentInvocationId(invId));
    if (!inv) {
      throw new Error(`Arbiter invocation ${invId} not found`);
    }

    const patched = inv.resultJsonPath ? inv : { ...inv, resultJsonPath: 'result.json' };
    const outcome = await extractResult({
      invocation: patched,
      ports: { artifacts, agent: deps.agent },
    });

    if (!outcome.ok) {
      throw new Error(`Failed to extract arbiter result: ${outcome.detail}`);
    }

    const arbiterResult = outcome.result as ArbiterResult;

    // Preserve rationale to a task-specific file for PR summary inclusion
    const rationalePath = `arbiter-rationale-${ctx.stepIndex}.md`;
    await artifacts.write({
      runId: ctx.runId,
      phaseId: 'arbitrate',
      relativePath: rationalePath,
      contents: arbiterResult.rationale,
    });

    return arbiterResult;
  }
}
