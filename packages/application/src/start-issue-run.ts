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
    const dir = RunDirectory.create({ rootDir: this.deps.runsDir, run });
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
    const exec = await runBashScript({
      scriptPath: this.deps.scriptPath,
      args: [String(input.issueNumber)],
      env,
      stdoutPath: dir.paths.stdoutLogPath,
      stderrPath: dir.paths.stderrLogPath,
      combinedPath: dir.paths.combinedLogPath,
    });
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
    dir.writeRunJson(finalRun);
    return {
      uuid: run.uuid,
      displayId: run.displayId,
      exitCode: exec.exitCode,
      status: finalStatus,
    };
  }
}
