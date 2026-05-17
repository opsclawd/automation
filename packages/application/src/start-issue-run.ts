import { createRun, passRun, failRun } from '@ai-sdlc/domain';
import type { Failure } from '@ai-sdlc/domain';
import { newRunId } from '@ai-sdlc/shared';
import type {
  ClassifyExitFn,
  FailureRepositoryPort,
  RunBashScriptFn,
  RunDirectoryFactory,
  RunDirectoryHandle,
  RunRepositoryPort,
} from './ports.js';

export interface StartIssueRunDeps {
  runRepository: RunRepositoryPort;
  failureRepository: FailureRepositoryPort;
  classifyExit: ClassifyExitFn;
  runDirectoryFactory: RunDirectoryFactory;
  runBashScript: RunBashScriptFn;
  runsDir: string;
  scriptPath: string;
  baseBranch?: string;
  model?: string;
  agentCli?: string;
  tee?: boolean;
  now?: () => Date;
  logger?: { error: (msg: string, err?: unknown) => void };
}

export interface StartIssueRunInput {
  issueNumber: number;
}

export interface StartIssueRunOutput {
  uuid: string;
  displayId: string;
  exitCode: number;
  status: 'passed' | 'failed';
}

export class StartIssueRun {
  constructor(private readonly deps: StartIssueRunDeps) {}

  async execute(input: StartIssueRunInput): Promise<StartIssueRunOutput> {
    const now = this.deps.now ?? (() => new Date());
    const logger = this.deps.logger ?? { error: (m, e) => console.error(m, e) };
    const startedAt = now();
    const ids = newRunId({ issueNumber: input.issueNumber, now: startedAt });
    const run = createRun({
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
    const env: Record<string, string> = {
      AI_RUN_UUID: run.uuid,
      AI_RUN_DISPLAY_ID: run.displayId,
      AI_RUN_DIR: dir.runRoot,
      AI_ISSUE_NUMBER: String(input.issueNumber),
    };
    if (this.deps.baseBranch !== undefined) env.AI_BASE_BRANCH = this.deps.baseBranch;
    if (this.deps.model !== undefined) env.AI_MODEL = this.deps.model;
    if (this.deps.agentCli !== undefined) env.AI_RUNTIME = this.deps.agentCli;

    // durationMs is measured inside runBashScript and is the authoritative
    // duration. startedAt/completedAt use the injectable `now` clock and may
    // drift slightly from durationMs.
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
        artifacts: [dir.paths.stdoutLogPath, dir.paths.stderrLogPath, dir.paths.combinedLogPath],
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
    const completedAt = now();
    const finalStatus: 'passed' | 'failed' = exec.exitCode === 0 ? 'passed' : 'failed';
    if (finalStatus === 'failed') {
      const tail = dir.readCombinedLog();
      const failure = this.deps.classifyExit({
        exitCode: exec.exitCode,
        combinedLogTail: tail,
        runUuid: run.uuid,
        artifacts: [dir.paths.stdoutLogPath, dir.paths.stderrLogPath, dir.paths.combinedLogPath],
        detectedAt: completedAt,
      });
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
  }
}
