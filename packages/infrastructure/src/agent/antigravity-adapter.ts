import { readFileSync, readdirSync, rmSync, existsSync, renameSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { CONTRACT_VIOLATION_CODES } from '@ai-sdlc/application/ports';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import { runExternalCli } from './external-cli-runner.js';

export interface AntigravityAdapterOptions {
  binaryPath?: string;
  artifactsDir: string;
  timeoutMsDefault?: number;
  env?: Record<string, string>;
  scratchDir?: string;
}

function clearDirectory(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    rmSync(resolve(dir, entry), { recursive: true, force: true });
  }
}

function findExpectedArtifactsInDir(scratchDir: string, expectedArtifacts: string[]): string[] {
  if (!existsSync(scratchDir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(scratchDir, { recursive: true, encoding: 'utf-8' })) {
    const name = basename(entry);
    if (expectedArtifacts.includes(name)) {
      found.push(entry);
    }
  }
  return found;
}

export class AntigravityAgentAdapter implements AgentPort {
  constructor(private readonly opts: AntigravityAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    const bin = this.opts.binaryPath ?? 'agy';
    const prompt = readFileSync(request.promptPath, 'utf-8');
    const scratchDir =
      this.opts.scratchDir ?? resolve(homedir(), '.gemini/antigravity-cli/scratch');

    // Pre: clear stale scratch state so agy does not load files
    // from a prior unrelated session.
    clearDirectory(scratchDir);

    // --add-dir registers the worktree as an agy workspace. Without it, agy
    // resolves relative artifact paths (e.g. ./spec-review-task-2.md) against
    // its own default workspace/scratch dir instead of request.cwd, so review
    // findings get written outside the worktree and the orchestrator never
    // sees them (observed on issue #146: the .md landed in ~/projects and
    // ~/.gemini/.../scratch instead of the worktree).
    const args = ['--dangerously-skip-permissions', '--add-dir', request.cwd, '--print', '-'];
    const result = await runExternalCli({
      runtime: 'antigravity',
      bin,
      args,
      input: prompt,
      detached: true,
      cwd: request.cwd,
      artifactsDir: this.opts.artifactsDir,
      model: request.model ?? '',
      ...(this.opts.env !== undefined ? { env: this.opts.env } : {}),
      ...(request.provider !== undefined ? { provider: request.provider } : {}),
      ...(this.opts.timeoutMsDefault !== undefined
        ? { timeoutMsDefault: this.opts.timeoutMsDefault }
        : {}),
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      startCommitSha: request.startCommitSha,
      expectedArtifacts: request.expectedArtifacts,
    });

    // Post: detect and recover artifacts wrongly written to scratch
    if (
      result.outcome === 'contract_violation' &&
      result.contractViolations.includes(CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT)
    ) {
      const stray = findExpectedArtifactsInDir(scratchDir, request.expectedArtifacts ?? []);
      if (stray.length > 0) {
        result.outcome = 'success';
        result.contractViolations = [CONTRACT_VIOLATION_CODES.ARTIFACT_IN_SCRATCH_DIR];
        for (const relPath of stray) {
          const dest = join(request.cwd, basename(relPath));
          renameSync(join(scratchDir, relPath), dest);
        }
        result.remediatedArtifacts = stray.map((relPath) => ({
          src: join(scratchDir, relPath),
          artifact: basename(relPath),
        }));
      }
    }

    return result;
  }
}
