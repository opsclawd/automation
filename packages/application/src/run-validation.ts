import {
  validationRunPassed,
  type RunId,
  type PhaseName,
  type ValidationRun,
  type ValidationCommandRecord,
} from '@ai-sdlc/domain';
import type { ValidationPort } from './ports/validation-port.js';
import type { ValidationRunRepositoryPort } from './ports/validation-run-repository-port.js';

export interface RunValidationDeps {
  validation: ValidationPort;
  validationRunRepository: ValidationRunRepositoryPort;
  idFactory: () => string;
  now: () => Date;
}

export interface RunValidationInputUC {
  runId: RunId;
  phaseId: PhaseName;
  cwd: string;
  logDir: string;
  commands: string[];
  timeoutSeconds: number;
  logPathPrefix?: string;
}

export interface RunValidationOutput {
  validationRun: ValidationRun;
  passed: boolean;
}

/**
 * RunValidation implements the validation execution use case.
 *
 * NOTE: This class intentionally does NOT implement `RunValidationUseCase`
 * (use-cases.ts:44) because the interface has signature
 * `execute({ runId }): Promise<{ ok: boolean }>` while this class has a richer
 * signature carrying `phaseId`, `cwd`, `logDir`, `commands`, `timeoutSeconds`,
 * and returns `{ validationRun, passed }`.  M5-05 is the bridge: it will
 * map the narrow interface to this richer implementation or update the
 * interface to match.
 */
export class RunValidation {
  constructor(private readonly deps: RunValidationDeps) {}

  /**
   * Executes validation commands and persists the result.
   *
   * The `validation-result.json` artifact is written by `ProcessValidationAdapter`
   * (not by this use case), to keep file I/O in the infrastructure layer per
   * the layer architecture.  The adapter writes it to `logDir/validation-result.json`.
   */
  async execute(input: RunValidationInputUC): Promise<RunValidationOutput> {
    if (input.commands.length === 0) {
      throw new Error('no validation commands configured (validation.commands is empty)');
    }
    const startedAt = this.deps.now();
    const results = await this.deps.validation.run({
      cwd: input.cwd,
      commands: input.commands,
      timeoutSeconds: input.timeoutSeconds,
      logDir: input.logDir,
      ...(input.logPathPrefix ? { logPathPrefix: input.logPathPrefix } : {}),
    });

    const commands: ValidationCommandRecord[] = results.map((r) => ({
      command: r.command,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      stdoutPath: r.stdoutPath,
      stderrPath: r.stderrPath,
      outcome: r.outcome,
    }));

    const validationRun: ValidationRun = {
      id: this.deps.idFactory(),
      runId: input.runId,
      phaseId: input.phaseId,
      startedAt,
      completedAt: this.deps.now(),
      commands,
    };
    this.deps.validationRunRepository.save(validationRun);

    return { validationRun, passed: validationRunPassed(validationRun) };
  }
}
