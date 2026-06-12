#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { composeRoot } from '@ai-sdlc/api/compose.js';
import { AgentProfileName, RunId, createRun, type Run } from '@ai-sdlc/domain';
import type { AgentInvocationResult } from '@ai-sdlc/application';
import { ConfigError, loadConfig, PHASE_FALLBACKS } from '@ai-sdlc/shared';
import { createReadStream, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

interface Flags {
  phase?: string;
  profile?: string;
  cwd?: string;
  'run-id'?: string;
  'repo-id'?: string;
  'repo-root'?: string;
  'phase-id'?: string;
  'step-id'?: string;
  'prompt-file'?: string;
  'expected-artifacts'?: string;
  'timeout-minutes'?: string;
  'start-sha'?: string;
  'worktree-dir'?: string;
}

export type ConfigForProfileResolution = {
  profiles: Record<string, unknown>;
  phaseProfiles: Record<string, { profile: string }>;
};

export type ProfileResolution = { ok: true; profileName: string } | { ok: false; error: string };

export function validateRequiredFlags(values: Flags): string[] {
  const missing: string[] = [];
  if (!values.cwd) missing.push('--cwd');
  if (!values['run-id']) missing.push('--run-id');
  if (!values['repo-id']) missing.push('--repo-id');
  if (!values['phase-id']) missing.push('--phase-id');
  if (!values['prompt-file']) missing.push('--prompt-file');
  if (!values['start-sha']) missing.push('--start-sha');
  return missing;
}

export function exitCodeForOutcome(
  result: Pick<AgentInvocationResult, 'outcome' | 'contractViolations'>,
): number {
  if (result.outcome === 'success') return 0;
  if (result.outcome === 'timeout') return 2;
  if (result.outcome === 'contract_violation') return 1;
  if (result.outcome === 'failed') {
    // Caller-aborted (e.g. --timeout-minutes signal) includes
    // cancelled_by_orchestrator and maps to exit 2 (timeout) so the
    // Bash orchestrator_fail path fires as designed.
    if (result.contractViolations.includes('cancelled_by_orchestrator')) return 2;
    // Advisory: provider/quota error only — not a hard failure.
    // The orchestrator treats exit 4 as warn-and-continue, letting
    // existing work-existence checks (NO_OUTPUT, missing commit) decide.
    if (
      result.contractViolations.includes('provider_error') &&
      result.contractViolations.length === 1
    )
      return 4;
    // All other runtime failures map to exit 3 (unexpected error).
    return 3;
  }
  return 3;
}

// True when --cwd resolves to the same path as --repo-root (the main checkout)
// while a worktree is expected. Running an agent in REPO_ROOT lets stray writes
// and commits corrupt the main branch. Skipped when no worktree is configured
// (e.g. consolidation workflows that intentionally run from REPO_ROOT).
export function cwdViolatesRepoRoot(values: Flags, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!values['repo-root'] || !values.cwd) return false;
  if (!values['worktree-dir'] && !env.POLL_WORKTREE) return false;
  return resolve(values.cwd) === resolve(values['repo-root']);
}

export function resolveProfileName(
  config: ConfigForProfileResolution,
  values: { profile?: string; phase?: string },
): ProfileResolution {
  if (values.profile) {
    if (!config.profiles[values.profile]) {
      return { ok: false, error: `unknown profile: ${values.profile}` };
    }
    return { ok: true, profileName: values.profile };
  }
  if (values.phase) {
    let phaseName = values.phase;
    let entry = config.phaseProfiles[phaseName];
    if (!entry) {
      const fallback = PHASE_FALLBACKS[phaseName];
      if (fallback) {
        entry = config.phaseProfiles[fallback];
        if (entry) phaseName = fallback;
      }
    }
    if (!entry) {
      return {
        ok: false,
        error: `unknown phase: ${values.phase} (no entry in agent.phaseProfiles)`,
      };
    }
    if (!entry.profile) {
      return {
        ok: false,
        error: `phase '${phaseName}' has no profile configured`,
      };
    }
    return { ok: true, profileName: entry.profile };
  }
  return { ok: false, error: 'must pass --phase or --profile' };
}

const PHASE_RUN_TYPE_MAP: Record<string, Run['type']> = {
  compound: 'consolidate',
};

export function phaseToRunType(phase: string | undefined): Run['type'] {
  if (phase) {
    const mapped = PHASE_RUN_TYPE_MAP[phase];
    if (mapped !== undefined) return mapped;
  }
  return 'pr_review';
}

/**
 * Walk up from `dir` to find the repo root (containing pnpm-workspace.yaml).
 */
function findRepoRoot(dir: string): string {
  let current = resolve(dir);
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  console.error('could not find repo root (no pnpm-workspace.yaml found)');
  process.exit(2);
}

/**
 * run-agent CLI
 *
 * Exit codes:
 *   0 — success
 *   1 — contract violation (M4-04 validateAgentContract failed or M4-05 extractResult failed)
 *   2 — config error (unknown phase, unknown profile, missing required flags) or timeout
 *   3 — adapter spawn failure (unexpected error)
 *   4 — advisory: provider/quota error only (warn-and-continue, not a hard failure)
 *
 * Usage (from Bash):
 *   NODE_OPTIONS='--conditions=development' pnpm --filter @ai-sdlc/cli exec tsx apps/cli/src/run-agent.ts \
 *     --phase <phase> \
 *     --cwd <worktree> \
 *     --repo-root <canonical-repo-root> \
 *     --run-id <uuid> \
 *     --repo-id <owner/repo> \
 *     --phase-id <name> \
 *     --prompt-file <path> \
 *     --start-sha <sha>
 *
 * Runs from TypeScript source via tsx (no build required), matching
 * the project's existing dev pattern (apps/api uses node --import tsx/esm).
 * The --conditions=development flag enables workspace package resolution
 * of src/ rather than dist/ (all packages export a "development" condition).
 */
export async function streamTranscript(
  filePath: string | undefined,
  destination: NodeJS.WritableStream,
): Promise<void> {
  if (!filePath || !existsSync(filePath)) return;
  await new Promise<void>((resolve) => {
    const source = createReadStream(filePath, { encoding: 'utf-8' });
    source
      .on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') {
          console.error('Failed to stream adapter transcript:', err);
        }
        resolve();
      })
      .on('end', resolve)
      .pipe(destination, { end: false });
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      phase: { type: 'string' },
      profile: { type: 'string' },
      cwd: { type: 'string' },
      'run-id': { type: 'string' },
      'repo-id': { type: 'string' },
      'repo-root': { type: 'string' },
      'phase-id': { type: 'string' },
      'step-id': { type: 'string' },
      'prompt-file': { type: 'string' },
      'expected-artifacts': { type: 'string' },
      'timeout-minutes': { type: 'string' },
      'start-sha': { type: 'string' },
    },
    allowPositionals: false,
  }) as { values: Flags };

  // Validate required flags
  const missing = validateRequiredFlags(values);
  if (missing.length > 0) {
    console.error(`missing required flag(s): ${missing.join(', ')}`);
    process.exit(2);
  }

  // Validate prompt file exists
  if (!existsSync(values['prompt-file']!)) {
    console.error(`prompt file not found: ${values['prompt-file']}`);
    process.exit(3);
  }

  // Resolve repo root: explicit flag (canonical main checkout) wins over
  // walking up from --cwd (which may land inside a worktree that contains
  // its own pnpm-workspace.yaml, producing the wrong root for DB lookups).
  const repoRoot = values['repo-root'] ?? findRepoRoot(values.cwd!);

  // Agent cwd must never be REPO_ROOT when a worktree is expected (the main
  // checkout on main). Running agents in REPO_ROOT allows stray writes and
  // commits to corrupt the main branch. Use a worktree directory instead.
  if (cwdViolatesRepoRoot(values)) {
    console.error(
      'agent cwd must not be REPO_ROOT (main checkout). Use a worktree directory instead.',
    );
    process.exit(2);
  }

  // Load config from repo root
  let config;
  try {
    config = loadConfig(repoRoot);
  } catch (err) {
    if (err instanceof ConfigError && (err.cause as { code?: string })?.code === 'ENOENT') {
      console.error('no .ai-orchestrator.json found at repo root');
      process.exit(2);
    }
    throw err;
  }

  if (!config.agent) {
    console.error('no agent config in .ai-orchestrator.json');
    process.exit(2);
  }

  const resolution = resolveProfileName(config.agent, values);
  if (!resolution.ok) {
    console.error(resolution.error);
    process.exit(2);
  }
  const profileName = resolution.profileName;

  // Build invocation request
  const expectedArtifacts = values['expected-artifacts']?.split(',').filter(Boolean) ?? [];
  let abortSignal: AbortSignal | undefined;
  if (values['timeout-minutes']) {
    const ms = parseInt(values['timeout-minutes'], 10) * 60 * 1000;
    if (!isNaN(ms) && ms > 0) {
      abortSignal = AbortSignal.timeout(ms);
    }
  }

  // Compose container and invoke agent
  const c = composeRoot({ repoRoot, scriptPath: '/dev/null', runStartupSweeps: false });
  if (!c.agentRuntime) {
    console.error('agent runtime not configured');
    process.exit(2);
  }

  // Ensure a runs row exists for the given runId. When invoked via
  // StartIssueRun (ai-run-issue-v2), the row already exists. When invoked
  // standalone (e.g. ai-pr-review-poll), no row exists, which would violate
  // the agent_invocations.run_uuid FK constraint.
  let createdSynthetic = false;
  const runId = values['run-id']!;
  if (!c.runRepository.findByUuid(runId)) {
    const run = createRun({
      uuid: runId,
      displayId: runId,
      issueNumber: 0,
      startedAt: new Date(),
      type: phaseToRunType(values.phase),
    });
    c.runRepository.insert(run);
    createdSynthetic = true;
  }

  // When the bash wrapper wraps this process with GNU timeout(1) and the
  // timeout fires, the process receives SIGTERM. If a synthetic run was
  // inserted, mark it terminal before exiting so the dashboard doesn't show
  // a perpetually-running row. runRepository.update() is synchronous, so
  // this runs reliably in the signal handler.
  const onSigterm = () => {
    if (createdSynthetic) {
      c.runRepository.update(runId, {
        status: 'failed',
        completedAt: new Date(),
        failureReason: 'process timed out',
      });
      // Close any open agent_invocations rows that
      // AgentRuntimeRouter.dispatch() may have inserted before the
      // timeout signal arrived, so the dashboard doesn't show
      // perpetually-running invocations.
      const invocations = c.agentInvocationRepository.listByRun(RunId(runId));
      for (const inv of invocations) {
        if (!inv.endedAt) {
          c.agentInvocationRepository.update(inv.id, {
            endedAt: new Date(),
            outcome: 'timeout',
            contractViolations: [],
          });
        }
      }
    }
    process.exit(124);
  };

  process.on('SIGTERM', onSigterm);

  function safeExit(code: number): never {
    process.removeListener('SIGTERM', onSigterm);
    process.exit(code);
  }

  try {
    const result = await c.agentRuntime.invoke({
      profile: AgentProfileName(profileName),
      promptPath: values['prompt-file']!,
      expectedArtifacts,
      cwd: values.cwd!,
      runId: values['run-id']!,
      repoId: values['repo-id']!,
      phaseId: values['phase-id']!,
      startCommitSha: values['start-sha']!,
      ...(abortSignal ? { abortSignal } : {}),
      ...(values['step-id'] ? { stepId: values['step-id'] } : {}),
    });

    await streamTranscript(result.stdoutPath, process.stdout);
    await streamTranscript(result.stderrPath, process.stderr);

    if (createdSynthetic) {
      c.runRepository.update(runId, {
        status: result.outcome === 'success' ? 'passed' : 'failed',
        completedAt: new Date(),
        ...(result.outcome !== 'success' ? { failureReason: `agent exit: ${result.outcome}` } : {}),
      });
    }

    safeExit(exitCodeForOutcome(result));
  } catch (e) {
    if (createdSynthetic) {
      c.runRepository.update(runId, {
        status: 'failed',
        completedAt: new Date(),
        failureReason: e instanceof Error ? e.message : String(e),
      });
    }

    if (e instanceof ConfigError) {
      console.error(e.message);
      safeExit(2);
    }
    console.error(e);
    safeExit(3);
  }
}

// Avoid auto-executing when imported by tests
if (!process.env.VITEST) {
  void main();
}
