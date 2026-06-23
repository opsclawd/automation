import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  baseTmpDir: string;
  resolveProfileForPhase: (phaseName: string) => AgentProfileName;
  idFactory: () => string;
}

export function createVerifyCodeChange(deps: VerifyCodeChangeDeps): VerifyCodeChangeFn {
  return async (input) => {
    let profile: AgentProfileName;
    try {
      profile = deps.resolveProfileForPhase('verify-pr-review');
    } catch {
      return { pass: true, reason: 'verify-pr-review phase not configured; check skipped' };
    }

    let filesChanged: string[] = [];
    try {
      const out = execFileSync(
        'git',
        ['diff', '--name-only', input.startCommitSha, input.fixCommitSha],
        { cwd: input.cwd, encoding: 'utf-8' },
      );
      filesChanged = out.trim().split('\n').filter(Boolean);
    } catch {}

    let codeWindow = '(file unreadable or not found)';
    try {
      const fullPath = join(input.cwd, input.path);
      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      const startLine = Math.max(0, input.line - 11);
      const endLine = Math.min(lines.length, input.line + 10);
      codeWindow = lines
        .slice(startLine, endLine)
        .map((l, i) => `${startLine + i + 1}: ${l}`)
        .join('\n');
    } catch {}

    const verifyDir = join(deps.baseTmpDir, `verify-code-${deps.idFactory()}`);
    mkdirSync(verifyDir, { recursive: true });
    const promptPath = join(verifyDir, 'prompt.md');
    const filesSection =
      filesChanged.length > 0
        ? filesChanged.map((f) => `- ${f}`).join('\n')
        : '(no changed files detected)';
    const prompt = [
      '# Code Verification Task',
      '',
      "Your only job: determine if the current code satisfies the reviewer's original concern.",
      'Do NOT edit any files.',
      '',
      "## Reviewer's Original Concern",
      '',
      `**File:** \`${input.path}\` (line ${input.line})`,
      '',
      '**Comment:**',
      input.commentBody,
      '',
      '## Files Changed in This Fix',
      '',
      filesSection,
      '',
      '## Current Code at Fix Site',
      '',
      `Lines around \`${input.path}:${input.line}\`:`,
      '',
      '```',
      codeWindow,
      '```',
      '',
      '## Required Output',
      '',
      `Write a result.json file at: ${join(verifyDir, 'result.json')}`,
      '',
      '```json',
      '{ "pass": true | false, "reason": "<one concise sentence>" }',
      '```',
      '',
      'Return `pass: true` only if the code clearly addresses the concern.',
      'Return `pass: false` with a one-sentence reason if not.',
    ].join('\n');
    writeFileSync(promptPath, prompt, 'utf-8');

    let invocation;
    try {
      invocation = await deps.agent.invoke({
        profile,
        promptPath,
        expectedArtifacts: ['result.json'],
        cwd: verifyDir,
        runId: input.runId,
        repoId: input.repoId,
        phaseId: 'verify-pr-review',
        startCommitSha: input.fixCommitSha,
        timeoutMs: 5 * 60_000,
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

    try {
      const resultPath = invocation.resultJsonPath ?? join(verifyDir, 'result.json');
      const raw = readFileSync(resultPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).pass === 'boolean' &&
        typeof (parsed as Record<string, unknown>).reason === 'string'
      ) {
        const r = parsed as { pass: boolean; reason: string };
        return { pass: r.pass, reason: r.reason };
      }
      return { pass: false, reason: 'verifier returned invalid result.json structure' };
    } catch {
      return { pass: false, reason: 'verifier result.json could not be parsed' };
    }
  };
}
