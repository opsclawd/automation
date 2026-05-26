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
 *   node apps/cli/dist/run-agent.js \
 *     --phase <phase> \
 *     --cwd <worktree> \
 *     --run-id <uuid> \
 *     --repo-id <owner/repo> \
 *     --phase-id <name> \
 *     --prompt-file <path> \
 *     --start-sha <sha>
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
  const missing: string[] = [];
  if (!values.cwd) missing.push('--cwd');
  if (!values['run-id']) missing.push('--run-id');
  if (!values['repo-id']) missing.push('--repo-id');
  if (!values['phase-id']) missing.push('--phase-id');
  if (!values['prompt-file']) missing.push('--prompt-file');
  if (!values['start-sha']) missing.push('--start-sha');
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

  let profileName: string;
  if (values.profile) {
    if (!config.agent.profiles[values.profile]) {
      console.error(`unknown profile: ${values.profile}`);
      process.exit(2);
    }
    profileName = values.profile;
  } else if (values.phase) {
    const entry = config.agent.phaseProfiles[values.phase];
    if (!entry) {
      console.error(`unknown phase: ${values.phase} (no entry in agent.phaseProfiles)`);
      process.exit(2);
    }
    profileName = entry.profile;
  } else {
    console.error('must pass --phase or --profile');
    process.exit(2);
  }

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

    if (result.outcome === 'success') process.exit(0);
    if (result.outcome === 'timeout') process.exit(2);
    if (result.outcome === 'contract_violation') process.exit(1);
    process.exit(3);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(2);
    }
    console.error(e);
    process.exit(3);
  }
}

void main();
