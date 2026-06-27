import {
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
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

function validateScratchDir(dir: string): void {
  const resolved = resolve(dir);
  const home = resolve(homedir());
  const cwd = resolve(process.cwd());
  const temp = resolve(tmpdir());

  if (
    resolved === '/' ||
    resolved === home ||
    resolved === cwd ||
    home.startsWith(resolved) ||
    cwd.startsWith(resolved)
  ) {
    throw new Error(`Unsafe scratch directory path: ${dir}`);
  }

  const inGemini = resolved.startsWith(join(home, '.gemini'));
  const inTemp = resolved.startsWith(temp);

  if (!inGemini && !inTemp) {
    throw new Error(`Scratch directory must be inside .gemini or temp directory: ${dir}`);
  }
}

function clearDirectory(dir: string): void {
  validateScratchDir(dir);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    rmSync(resolve(dir, entry), { recursive: true, force: true });
  }
}

function findExpectedArtifactsInDir(scratchDir: string, expectedArtifacts: string[]): string[] {
  if (!existsSync(scratchDir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(scratchDir, { recursive: true, encoding: 'utf-8' })) {
    const fullPath = join(scratchDir, entry);
    if (existsSync(fullPath) && statSync(fullPath).isFile()) {
      const name = basename(entry);
      if (expectedArtifacts.includes(name)) {
        found.push(entry);
      }
    }
  }
  return found;
}

export class AntigravityAgentAdapter implements AgentPort {
  constructor(private readonly opts: AntigravityAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    const bin = this.opts.binaryPath ?? 'agy';
    const prompt = readFileSync(request.promptPath, 'utf-8');
    const baseScratchDir =
      this.opts.scratchDir ?? resolve(homedir(), '.gemini/antigravity-cli/scratch');
    const scratchDir = this.opts.scratchDir
      ? baseScratchDir
      : join(baseScratchDir, basename(request.cwd));

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
        for (const relPath of stray) {
          const dest = join(request.cwd, basename(relPath));
          const src = join(scratchDir, relPath);
          try {
            renameSync(src, dest);
          } catch (err) {
            const error = err as { code?: string };
            if (error.code === 'EXDEV') {
              copyFileSync(src, dest);
              unlinkSync(src);
            } else {
              throw err;
            }
          }
        }
        result.remediatedArtifacts = stray.map((relPath) => ({
          src: join(scratchDir, relPath),
          artifact: basename(relPath),
        }));

        // Validate if all expected artifacts now exist in the workspace cwd
        const allRecovered = (request.expectedArtifacts ?? []).every((art) =>
          existsSync(join(request.cwd, art)),
        );

        if (allRecovered) {
          result.outcome = 'success';
          result.contractViolations = result.contractViolations.filter(
            (cv) => cv !== CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
          );
        }

        if (!result.contractViolations.includes(CONTRACT_VIOLATION_CODES.ARTIFACT_IN_SCRATCH_DIR)) {
          result.contractViolations.push(CONTRACT_VIOLATION_CODES.ARTIFACT_IN_SCRATCH_DIR);
        }
      }
    }

    return result;
  }
}
