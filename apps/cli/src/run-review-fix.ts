#!/usr/bin/env node
// SAFETY: config-sources.json MUST NOT contain file contents. It only contains
// paths and a sha256. Local (.local.json) files may contain secrets; never
// inline their content here.
import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { composeRoot } from '@ai-sdlc/api/compose.js';
import { RunId, PhaseName, AgentProfileName, createRun, RepositoryId } from '@ai-sdlc/domain';
import { ConfigError, loadLayeredConfig, type OrchestratorEvent } from '@ai-sdlc/shared';
import { formatEvent } from './format-event.js';

interface Flags {
  cwd?: string;
  'run-id'?: string;
  'repo-id'?: string;
  'repo-root'?: string;
  'phase-id'?: string;
  'max-iterations'?: string;
  'architect-plan-json'?: string;
  'target-repo-root'?: string;
}

export function validateRequiredFlags(values: Flags): string[] {
  const missing: string[] = [];
  if (!values.cwd) missing.push('--cwd');
  if (!values['run-id']) missing.push('--run-id');
  if (!values['repo-id']) missing.push('--repo-id');
  if (!values['repo-root']) missing.push('--repo-root');
  return missing;
}

export function exitCodeForPhaseOutcome(outcome: 'passed' | 'failed'): number {
  return outcome === 'passed' ? 0 : 1;
}

export function serializeEventForJsonl(event: OrchestratorEvent, displayId: string): string {
  return JSON.stringify({
    runId: displayId,
    ...(event.phase ? { phase: event.phase } : {}),
    level: event.level,
    type: event.type,
    message: event.message,
    timestamp: event.timestamp,
    metadata: event.metadata ?? {},
  });
}

/**
 * run-review-fix CLI
 *
 * Exit codes:
 *   0 — review/fix loop converged (phase passed)
 *   1 — loop exhausted or hard-failed (phase failed)
 *   2 — config error (missing flags / no .ai-orchestrator.json / no agent config / no reviewFixLoop)
 *   3 — unexpected error
 *
 * Usage (from Bash):
 *   NODE_OPTIONS='--conditions=development' node --import "$_TSX_LOADER" \
 *     apps/cli/src/run-review-fix.ts \
 *     --cwd <worktree> --run-id <uuid> --repo-id <owner/repo> \
 *     --repo-root <canonical-repo-root> --phase-id review-fix
 *
 * runStartupSweeps:false is mandatory (issue #107).
 */
async function main() {
  const { values } = parseArgs({
    options: {
      cwd: { type: 'string' },
      'run-id': { type: 'string' },
      'repo-id': { type: 'string' },
      'repo-root': { type: 'string' },
      'phase-id': { type: 'string' },
      'max-iterations': { type: 'string' },
      'architect-plan-json': { type: 'string' },
      'target-repo-root': { type: 'string' },
    },
    allowPositionals: false,
  }) as { values: Flags };

  const missing = validateRequiredFlags(values);
  if (missing.length > 0) {
    console.error(`missing required flag(s): ${missing.join(', ')}`);
    process.exit(2);
  }

  // --repo-root is required (enforced above), so no fallback is needed.
  const repoRoot = values['repo-root']!;
  const targetRepoRoot = values['target-repo-root'];

  let config;
  let layered;
  try {
    layered = loadLayeredConfig({
      automationRoot: repoRoot,
      ...(targetRepoRoot ? { targetRoot: targetRepoRoot } : {}),
    });
    config = layered.config;
  } catch (err) {
    if (err instanceof ConfigError && (err.cause as { code?: string })?.code === 'ENOENT') {
      console.error('no .ai-orchestrator.json found at repo root');
      process.exit(2);
    }
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    console.error(err);
    process.exit(3);
  }

  if (!config.agent) {
    console.error('no agent config in .ai-orchestrator.json');
    process.exit(2);
  }

  const reviewEntry = config.agent.phaseProfiles['whole-pr-review'];
  const fixEntry = config.agent.phaseProfiles['fix-review'];
  if (!reviewEntry?.profile || !fixEntry?.profile) {
    console.error('agent.phaseProfiles must define whole-pr-review and fix-review');
    process.exit(2);
  }

  let c;
  try {
    c = composeRoot({ repoRoot, scriptPath: '/dev/null', runStartupSweeps: false });
  } catch (err) {
    console.error(err);
    process.exit(3);
  }

  if (!c.reviewFixLoop) {
    console.error('review/fix loop not configured (agent runtime missing)');
    process.exit(2);
  }

  const runId = values['run-id']!;
  if (!c.runRepository.findByUuid(runId)) {
    c.runRepository.insert(
      createRun({
        uuid: runId,
        displayId: runId,
        repoId: RepositoryId(values['repo-id'] || 'synthetic'),
        issueNumber: 0,
        startedAt: new Date(),
      }),
    );
  }

  const runsDirFor = (id: string) => {
    const dId = c.runRepository.findByUuid(id)?.displayId ?? id;
    return join(c.runsDir, dId);
  };

  const runDir = runsDirFor(runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'config-sources.json'),
    JSON.stringify({ fingerprint: layered.fingerprint, sources: layered.sources }, null, 2),
  );

  const phaseId = values['phase-id'] ?? 'review-fix';
  const maxIterations = values['max-iterations']
    ? parseInt(values['max-iterations'], 10)
    : config.phases.reviewFix.maxIterations;

  let architectPlan:
    | {
        version: number;
        tasks: Array<{
          task_id: string;
          approach: string;
          conflicts_resolved: string[];
          constraints: string[];
          depends_on: string[];
        }>;
      }
    | undefined;
  const architectPlanPath = values['architect-plan-json'];
  if (architectPlanPath) {
    try {
      const raw = JSON.parse(readFileSync(architectPlanPath, 'utf-8'));
      if (
        typeof raw !== 'object' ||
        raw === null ||
        typeof raw.version !== 'number' ||
        !Array.isArray(raw.tasks)
      ) {
        console.error(`architect plan must contain version (number) and tasks (array)`);
        process.exit(2);
      }
      architectPlan = {
        version: raw.version,
        tasks: (raw.tasks as Array<Record<string, unknown>>).map((t, i) => ({
          task_id: String(t.task_id ?? `task-${i}`),
          approach: String(t.approach ?? ''),
          conflicts_resolved: Array.isArray(t.conflicts_resolved) ? t.conflicts_resolved : [],
          constraints: Array.isArray(t.constraints) ? t.constraints : [],
          depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
        })),
      };
    } catch (err) {
      console.error(`failed to read architect plan from ${architectPlanPath}: ${err}`);
      process.exit(2);
    }
  }

  const eventsFile = process.env.AI_RUN_EVENTS_FILE;
  const displayId = process.env.AI_RUN_DISPLAY_ID;
  const appendEvent =
    eventsFile && displayId
      ? (event: OrchestratorEvent): void => {
          try {
            const jsonLine = serializeEventForJsonl(event, displayId);
            appendFileSync(eventsFile, jsonLine + '\n');
          } catch {
            // Best-effort: file I/O failure must not crash the loop
          }
        }
      : undefined;

  let unsub: (() => void) | undefined;
  try {
    unsub = c.eventBus.subscribe(runId, (event: OrchestratorEvent) => {
      try {
        console.error(formatEvent(event));
      } catch {
        // Best-effort: stderr write must not crash the loop
      }
      appendEvent?.(event);
    });

    const result = await c.reviewFixLoop.execute({
      runId: RunId(runId),
      phaseId: PhaseName(phaseId),
      repoId: values['repo-id']!,
      cwd: values.cwd!,
      maxIterations,
      blockOnSeverity: config.phases.reviewFix.blockOnSeverity,
      reviewProfile: AgentProfileName(reviewEntry.profile),
      fixProfile: AgentProfileName(fixEntry.profile),
      ...(fixEntry.fallbackProfile
        ? { fixFallbackProfile: AgentProfileName(fixEntry.fallbackProfile) }
        : {}),
      ...(architectPlan !== undefined ? { architectPlan } : {}),
    });
    const { phaseOutcome, loop } = result;
    console.error(
      `review-fix: ${phaseOutcome.toUpperCase()} (${loop.iterations.length}/${loop.maxIterations} iterations, status=${loop.status})`,
    );
    if (result.loopStatus === 'converged_with_notes') {
      const residualCount = result.residualFindingsCount;
      console.warn(
        `[review-fix] loop converged with residual findings (${residualCount ?? '?'} findings) — see code-review.md`,
      );
      process.exit(0);
    }
    process.exit(exitCodeForPhaseOutcome(phaseOutcome));
  } catch (e) {
    console.error(e);
    process.exit(3);
  } finally {
    try {
      unsub?.();
    } catch {
      // Best-effort: unsubscribe failure must not overwrite the phase result
    }
  }
}

if (!process.env.VITEST) {
  void main();
}
