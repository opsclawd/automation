import { readFileSync } from 'node:fs';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import { runExternalCli } from './external-cli-runner.js';

export interface CodexAdapterOptions {
  binaryPath?: string;
  artifactsDir: string;
  timeoutMsDefault?: number;
}

/**
 * Experimental reviewer/adjudicator-only runtime backed by the Codex CLI (`codex`).
 *
 * Verified headless contract (codex-cli 0.130.0):
 *   codex exec --sandbox read-only --color never "<prompt>"
 *
 * read-only sandbox forbids writes and unsandboxed command execution. The
 * adapter NEVER passes --dangerously-bypass-approvals-and-sandbox or a writable
 * sandbox mode. Quota errors surface on stderr as "ERROR: Quota exceeded ..."
 * which QUOTA_PATTERNS classifies as quota_exceeded (triggering fallback).
 */
export class CodexAgentAdapter implements AgentPort {
  constructor(private readonly opts: CodexAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    const bin = this.opts.binaryPath ?? 'codex';
    const prompt = readFileSync(request.promptPath, 'utf-8');
    const args = ['exec', '--sandbox', 'read-only', '--color', 'never'];
    if (request.model && request.model !== 'default') {
      args.push('--model', request.model);
    }
    return runExternalCli({
      input: prompt,
      runtime: 'codex',
      bin,
      args,
      cwd: request.cwd,
      artifactsDir: this.opts.artifactsDir,
      model: request.model ?? '',
      ...(request.provider !== undefined ? { provider: request.provider } : {}),
      ...(this.opts.timeoutMsDefault !== undefined
        ? { timeoutMsDefault: this.opts.timeoutMsDefault }
        : {}),
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      startCommitSha: request.startCommitSha,
      expectedArtifacts: request.expectedArtifacts,
    });
  }
}
