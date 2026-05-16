import { createRun, passRun, failRun } from '@ai-sdlc/domain';
import { newRunId } from '@ai-sdlc/shared';
import { RunDirectory, runBashScript, type RunRepository } from '@ai-sdlc/infrastructure';

export interface StartIssueRunDeps {
  runRepository: RunRepository;
  runsDir: string;
  scriptPath: string;
  baseBranch?: string;
  model?: string;
  agentCli?: string;
  now?: () => Date;
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
    const startedAt = now();
    const ids = newRunId({ issueNumber: input.issueNumber, now: startedAt });
    const run = createRun({
      uuid: ids.uuid,
      displayId: ids.displayId,
      issueNumber: input.issueNumber,
      startedAt,
    });
    this.deps.runRepository.insertIfNoActive(run);
    let dir: RunDirectory;
    try {
      dir = RunDirectory.create({ rootDir: this.deps.runsDir, run });
    } catch (err) {
      this.deps.runRepository.update(run.uuid, { status: 'cancelled' });
      throw err;
    }
    const env: Record<string, string> = {
      AI_RUN_UUID: run.uuid,
      AI_RUN_DISPLAY_ID: run.displayId,
      AI_RUN_DIR: dir.runRoot,
      AI_ISSUE_NUMBER: String(input.issueNumber),
    };
    if (this.deps.baseBranch !== undefined) {
      env.AI_BASE_BRANCH = this.deps.baseBranch;
    }
    if (this.deps.model !== undefined) {
      env.AI_MODEL = this.deps.model;
    }
    if (this.deps.agentCli !== undefined) {
      env.AI_RUNTIME = this.deps.agentCli;
    }
    let exec: Awaited<ReturnType<typeof runBashScript>>;
    // durationMs comes from runBashScript (infrastructure-level Date.now()), which
    // is the authoritative duration measurement. startedAt/completedAt use the
    // injectable `now` clock and may drift slightly from durationMs.
    try {
      exec = await runBashScript({
        scriptPath: this.deps.scriptPath,
        args: [String(input.issueNumber)],
        env,
        stdoutPath: dir.paths.stdoutLogPath,
        stderrPath: dir.paths.stderrLogPath,
        combinedPath: dir.paths.combinedLogPath,
      });
    } catch (err) {
      const errorDuration = now().getTime() - startedAt.getTime();
      this.deps.runRepository.update(run.uuid, {
        status: 'cancelled',
        completedAt: now(),
        failureReason: err instanceof Error ? err.message : String(err),
        durationMs: errorDuration,
      });
      throw err;
    }
    const completedAt = now();
    const finalStatus: 'passed' | 'failed' = exec.exitCode === 0 ? 'passed' : 'failed';
    this.deps.runRepository.update(run.uuid, {
      status: finalStatus,
      completedAt,
      exitCode: exec.exitCode,
      durationMs: exec.durationMs,
      ...(finalStatus === 'failed'
        ? { failureReason: `script exited with code ${exec.exitCode}` }
        : {}),
    });
    const finalRun =
      finalStatus === 'passed'
        ? passRun(run, completedAt)
        : failRun(run, `exit ${exec.exitCode}`, completedAt);
    try {
      dir.writeRunJson(finalRun);
    } catch (err) {
      console.error(`Failed to write run.json for ${run.displayId}:`, err);
    }
    return {
      uuid: run.uuid,
      displayId: run.displayId,
      exitCode: exec.exitCode,
      status: finalStatus,
    };
  }
}
