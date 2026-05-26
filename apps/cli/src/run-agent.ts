#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { composeRoot } from '@ai-sdlc/api/compose.js';
import { AgentProfileName } from '@ai-sdlc/domain';
import { ConfigError, loadConfig } from '@ai-sdlc/shared';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

interface Flags {
  phase?: string;
  profile?: string;
  cwd?: string;
  'run-id'?: string;
  'repo-id'?: string;
  'phase-id'?: string;
  'step-id'?: string;
  'prompt-file'?: string;
  'expected-artifacts'?: string;
  'timeout-minutes'?: string;
  'start-sha'?: string;
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

export function exitCodeForOutcome(outcome: string): number {
  if (outcome === 'success') return 0;
  if (outcome === 'timeout') return 2;
  if (outcome === 'contract_violation') return 1;
  // 'failed' includes caller-aborted (cancelled_by_orchestrator) from
  // --timeout-minutes abort signal. Treat as timeout (exit 2) so the
  // Bash caller's orchestrator_fail path fires as designed.
  if (outcome === 'failed') return 2;
  return 3;
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
    const entry = config.phaseProfiles[values.phase];
    if (!entry) {
      return {
        ok: false,
        error: `unknown phase: ${values.phase} (no entry in agent.phaseProfiles)`,
      };
    }
    if (!entry.profile) {
      return {
        ok: false,
        error: `phase '${values.phase}' has no profile configured`,
      };
    }
    return { ok: true, profileName: entry.profile };
  }
  return { ok: false, error: 'must pass --phase or --profile' };
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
 *
 * Usage (from Bash):
 *   NODE_OPTIONS='--conditions=development' pnpm --filter @ai-sdlc/cli exec tsx apps/cli/src/run-agent.ts \
 *     --phase <phase> \
 *     --cwd <worktree> \
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
async function main() {
  const { values } = parseArgs({
    options: {
      phase: { type: 'string' },
      profile: { type: 'string' },
      cwd: { type: 'string' },
      'run-id': { type: 'string' },
      'repo-id': { type: 'string' },
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

  // Resolve repo root from cwd (cwd is the worktree dir)
  const repoRoot = findRepoRoot(values.cwd!);

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
  const c = composeRoot({ repoRoot, scriptPath: '/dev/null' });
  if (!c.agentRuntime) {
    console.error('agent runtime not configured');
    process.exit(2);
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

    process.exit(exitCodeForOutcome(result.outcome));
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(2);
    }
    console.error(e);
    process.exit(3);
  }
}

// Avoid auto-executing when imported by tests
if (!process.env.VITEST) {
  void main();
}
