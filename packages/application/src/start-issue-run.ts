import { createRun, passRun, failRun, cancelRun, type RepositoryId } from '@ai-sdlc/domain';
import type { Failure, ClassifierEvent } from '@ai-sdlc/domain';
import { newRunId } from '@ai-sdlc/shared';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type {
  ClassifyExitFn,
  EventRepositoryPort,
  EventBusPort,
  EventTailerFactory,
  FailureRepositoryPort,
  ResolveRefShaFn,
  RunBashScriptFn,
  RunDirectoryFactory,
  RunDirectoryHandle,
  RunRepositoryPort,
  TmpDirectoryFactory,
} from './ports.js';

export interface StartIssueRunDeps {
  runRepository: RunRepositoryPort;
  failureRepository: FailureRepositoryPort;
  classifyExit: ClassifyExitFn;
  runDirectoryFactory: RunDirectoryFactory;
  runBashScript: RunBashScriptFn;
  runsDir: string;
  scriptPath: string;
  eventRepository: EventRepositoryPort;
  eventBus: EventBusPort;
  createEventTailer: EventTailerFactory;
  baseTmpDir: string;
  tmpDirectoryFactory: TmpDirectoryFactory;
  baseBranch?: string;
  model?: string;
  agentCli?: string;
  tee?: boolean;
  now?: () => Date;
  logger?: { error: (msg: string, err?: unknown) => void };
  resolveRefSha?: ResolveRefShaFn;
}

export interface StartIssueRunInput {
  repoId: RepositoryId;
  issueNumber: number;
}

export interface StartIssueRunOutput {
  uuid: string;
  displayId: string;
  exitCode: number;
  status: 'passed' | 'failed' | 'cancelled';
}

export class StartIssueRun {
  constructor(private readonly deps: StartIssueRunDeps) {}

  async execute(input: StartIssueRunInput): Promise<StartIssueRunOutput> {
    const now = this.deps.now ?? (() => new Date());
    const logger = this.deps.logger ?? { error: (m, e) => console.error(m, e) };
    const startedAt = now();
    const ids = newRunId({ issueNumber: input.issueNumber, now: startedAt });
    const run = createRun({
      repoId: input.repoId,
      uuid: ids.uuid,
      displayId: ids.displayId,
      issueNumber: input.issueNumber,
      startedAt,
    });
    this.deps.runRepository.insertIfNoActive(run);
    let dir: RunDirectoryHandle;
    try {
      dir = this.deps.runDirectoryFactory({ rootDir: this.deps.runsDir, run });
    } catch (err) {
      const failureReason = err instanceof Error ? err.message : String(err);
      this.deps.runRepository.update(run.uuid, {
        status: 'failed',
        completedAt: now(),
        exitCode: -1,
        durationMs: 0,
        failureReason,
      });
      throw err;
    }
    let tmpDirHandle: ReturnType<TmpDirectoryFactory>;
    try {
      tmpDirHandle = this.deps.tmpDirectoryFactory({
        baseTmpDir: this.deps.baseTmpDir,
        runId: run.uuid,
      });
    } catch (err) {
      const failureReason = err instanceof Error ? err.message : String(err);
      this.deps.runRepository.update(run.uuid, {
        status: 'failed',
        completedAt: now(),
        exitCode: -1,
        durationMs: 0,
        failureReason,
      });
      throw err;
    }
    const env: Record<string, string> = {
      AI_RUN_UUID: run.uuid,
      AI_RUN_DISPLAY_ID: run.displayId,
      AI_RUN_DIR: dir.runRoot,
      AI_RUN_EVENTS_FILE: dir.paths.eventsJsonlPath,
      AI_ISSUE_NUMBER: String(input.issueNumber),
      TMPDIR: tmpDirHandle.tmpDir,
      SQLITE_TMPDIR: tmpDirHandle.tmpDir,
    };
    if (this.deps.baseBranch !== undefined) env.AI_BASE_BRANCH = this.deps.baseBranch;
    if (this.deps.model !== undefined) env.AI_AGENT_MODEL = this.deps.model;
    if (this.deps.agentCli !== undefined) env.AI_RUNTIME = this.deps.agentCli;

    const collectedEvents: ClassifierEvent[] = [];
    let classified = false;
    // After classifyExit runs, the classified flag prevents further events
    // from being pushed into collectedEvents. This also guards against events
    // arriving during the final tailer.drainAndStop() in the finally block —
    // those are post-classification and should not influence failure.json.
    const onEvent = (e: OrchestratorEvent): void => {
      if (classified) return;
      try {
        if (e.runId !== run.displayId) {
          logger.error(`Event runId mismatch for run ${run.displayId}: got ${e.runId}, skipping`);
          return;
        }
        collectedEvents.push(toClassifierEvent(e));
        const insertInput: Parameters<EventRepositoryPort['insert']>[0] = {
          runUuid: run.uuid,
          level: e.level,
          type: e.type,
          message: e.message,
          metadata: e.metadata,
          timestamp: new Date(e.timestamp),
        };
        if (e.phase !== undefined) insertInput.phase = e.phase;
        this.deps.eventRepository.insert(insertInput);
        this.deps.eventBus.publish(run.uuid, e);
      } catch (err) {
        logger.error(`Failed to process event for run ${run.displayId}`, err);
      }
    };
    const tailer = this.deps.createEventTailer({
      path: dir.paths.eventsJsonlPath,
      onEvent,
      onParseError: (err, line) => {
        logger.error(`Invalid event line for run ${run.displayId}: ${err.message}`, { line });
      },
    });
    try {
      await tailer.start();
      try {
        let exec: Awaited<ReturnType<RunBashScriptFn>>;
        try {
          exec = await this.deps.runBashScript({
            scriptPath: this.deps.scriptPath,
            args: [String(input.issueNumber)],
            env,
            stdoutPath: dir.paths.stdoutLogPath,
            stderrPath: dir.paths.stderrLogPath,
            combinedPath: dir.paths.combinedLogPath,
            tee: this.deps.tee ?? false,
          });
        } catch (err) {
          const errorDuration = now().getTime() - startedAt.getTime();
          const completedAt = now();
          const errorMessage = err instanceof Error ? err.message : String(err);
          const failure: Failure = {
            runUuid: run.uuid,
            kind: 'command_failed',
            message: errorMessage,
            exitCode: -1,
            canRetry: false,
            suggestedAction: 'Inspect the runner error and stderr.log for the cause.',
            artifacts: [
              dir.paths.stdoutLogPath,
              dir.paths.stderrLogPath,
              dir.paths.combinedLogPath,
            ],
            detectedAt: completedAt,
          };
          try {
            dir.writeFailureJson(failure);
          } catch (writeErr) {
            logger.error(`Failed to write failure.json for ${run.displayId}`, writeErr);
          }
          try {
            this.deps.failureRepository.insert(failure);
          } catch (dbErr) {
            logger.error(`Failed to insert failure record for ${run.displayId}`, dbErr);
          }
          this.deps.runRepository.update(run.uuid, {
            status: 'failed',
            completedAt,
            exitCode: -1,
            failureReason: errorMessage,
            durationMs: errorDuration,
          });
          try {
            dir.writeRunJson(failRun(run, errorMessage, completedAt));
          } catch (writeErr) {
            logger.error(`Failed to write run.json for ${run.displayId}`, writeErr);
          }
          throw err;
        }
        // Capture the actual start commit SHA from the worktree after the
        // script's fetch and worktree creation. The script fetches
        // origin/<baseBranch> before creating the worktree, so resolving the
        // ref from the worktree directory gives the correct baseline SHA.
        // The worktree lives at <repoRoot>/.ai-worktrees/issue-<n> (sibling of
        // runsDir = <repoRoot>/.ai-runs), NOT under runsDir. Derived via string
        // because the node:path module is disallowed in this layer (depcruise
        // rule application-no-io-except-prompt-template).
        if (this.deps.resolveRefSha) {
          try {
            const repoRoot = this.deps.runsDir.replace(/\/\.ai-runs$/, '');
            const worktreeRoot = `${repoRoot}/.ai-worktrees/issue-${run.issueNumber}`;
            const sha = this.deps.resolveRefSha(
              worktreeRoot,
              `origin/${this.deps.baseBranch ?? 'main'}`,
            );
            if (sha) {
              this.deps.runRepository.update(run.uuid, { startCommitSha: sha });
            }
          } catch (e) {
            logger.error(`Failed to capture startCommitSha from worktree for ${run.displayId}`, e);
          }
        }
        const completedAt = now();
        const finalStatus: 'passed' | 'failed' = exec.exitCode === 0 ? 'passed' : 'failed';
        // If the run was cancelled (e.g. via SIGTERM or `runs cancel`), do not
        // overwrite the terminal status with passed/failed.
        // Query by UUID (not issueNumber) to avoid picking up a newer run for
        // the same issue if one was inserted after cancellation.
        const current = this.deps.runRepository.findByUuid(run.uuid);
        if (current && ['passed', 'failed', 'cancelled'].includes(current.status)) {
          if (current.status === 'cancelled') {
            try {
              dir.writeRunJson(
                cancelRun(run, current.failureReason, current.completedAt ?? completedAt),
              );
            } catch (writeErr) {
              logger.error(`Failed to write run.json for ${run.displayId} on cancel`, writeErr);
            }
          } else if (current.status === 'failed') {
            try {
              dir.writeRunJson(
                failRun(
                  run,
                  current.failureReason ?? 'externally marked failed',
                  current.completedAt ?? completedAt,
                ),
              );
            } catch (writeErr) {
              logger.error(`Failed to write run.json for ${run.displayId} on fail`, writeErr);
            }
          } else if (current.status === 'passed') {
            try {
              dir.writeRunJson(passRun(run, current.completedAt ?? completedAt));
            } catch (writeErr) {
              logger.error(`Failed to write run.json for ${run.displayId} on pass`, writeErr);
            }
          }
          return {
            uuid: run.uuid,
            displayId: run.displayId,
            exitCode: exec.exitCode,
            status: current.status as 'passed' | 'failed' | 'cancelled',
          };
        }
        if (finalStatus === 'failed') {
          try {
            await tailer.drainAndStop();
          } catch (e) {
            logger.error('Failed to drain event tailer before classification', e);
          }
          const tail = dir.readCombinedLog();
          const failure = this.deps.classifyExit({
            exitCode: exec.exitCode,
            combinedLogTail: tail,
            runUuid: run.uuid,
            artifacts: [
              dir.paths.stdoutLogPath,
              dir.paths.stderrLogPath,
              dir.paths.combinedLogPath,
            ],
            detectedAt: completedAt,
            events: collectedEvents,
          });
          classified = true;
          try {
            dir.writeFailureJson(failure);
          } catch (err) {
            logger.error(`Failed to write failure.json for ${run.displayId}`, err);
          }
          try {
            this.deps.failureRepository.insert(failure);
          } catch (err) {
            logger.error(`Failed to insert failure record for ${run.displayId}`, err);
          }
          this.deps.runRepository.update(run.uuid, {
            status: 'failed',
            completedAt,
            exitCode: exec.exitCode,
            durationMs: exec.durationMs,
            failureReason: failure.message,
            ...(failure.phase ? { currentPhase: failure.phase } : {}),
          });
          try {
            dir.writeRunJson(failRun(run, failure.message, completedAt));
          } catch (err) {
            logger.error(`Failed to write run.json for ${run.displayId}`, err);
            const writeFailReason = err instanceof Error ? err.message : String(err);
            this.deps.runRepository.update(run.uuid, {
              failureReason: `${failure.message}; run.json write failed: ${writeFailReason}`,
            });
          }
        } else {
          // If the run is in 'waiting' (transitioned by pr-review poller's
          // onAllResolved), preserve it for future reactivation instead of
          // overwriting with 'passed' (#206).
          if (current?.status === 'waiting') {
            try {
              dir.writeRunJson(passRun(run, completedAt));
            } catch (writeErr) {
              logger.error(`Failed to write run.json for ${run.displayId}`, writeErr);
            }
            return {
              uuid: run.uuid,
              displayId: run.displayId,
              exitCode: exec.exitCode,
              status: 'passed',
            };
          }
          this.deps.runRepository.update(run.uuid, {
            status: 'passed',
            completedAt,
            exitCode: exec.exitCode,
            durationMs: exec.durationMs,
          });
          try {
            dir.writeRunJson(passRun(run, completedAt));
          } catch (err) {
            logger.error(`Failed to write run.json for ${run.displayId}`, err);
            const writeFailReason = err instanceof Error ? err.message : String(err);
            this.deps.runRepository.update(run.uuid, {
              failureReason: `passed; run.json write failed: ${writeFailReason}`,
            });
          }
        }
        return {
          uuid: run.uuid,
          displayId: run.displayId,
          exitCode: exec.exitCode,
          status: finalStatus,
        };
      } finally {
        try {
          await tailer.drainAndStop();
        } catch (e) {
          logger.error('Failed to drain event tailer', e);
        }
      }
    } finally {
      try {
        tmpDirHandle.remove();
      } catch (e) {
        logger.error('Failed to remove run tmp directory', e);
      }
    }
  }
}

function toClassifierEvent(e: OrchestratorEvent): ClassifierEvent {
  // Only include `phase` when present — `...(cond && { key: val })` spreads
  // to nothing when falsy, omitting the key entirely rather than setting it
  // to undefined.
  //
  // Exhaustiveness: every field of ClassifierEvent must appear in the return
  // object. If ClassifierEvent gains a new required field, TypeScript will
  // error here until the mapping is updated.
  const result: ClassifierEvent = {
    ...(e.phase !== undefined && { phase: e.phase }),
    level: e.level,
    type: e.type,
    message: e.message,
    timestamp: e.timestamp,
    metadata: e.metadata,
  };
  return result;
}
