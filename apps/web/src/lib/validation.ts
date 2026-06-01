export interface ValidationCommandDto {
  command: string;
  kind: string | null;
  outcome: 'passed' | 'failed' | 'timed_out';
  exitCode: number;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  classifier: string | null;
}

export interface ValidationRunDto {
  id: string;
  phaseId: string;
  startedAt: string;
  completedAt: string | null;
  passed: boolean;
  commands: ValidationCommandDto[];
}

/** Failing/timed-out commands first; stable within each group; never mutates input. */
export function sortCommandsFailingFirst(commands: ValidationCommandDto[]): ValidationCommandDto[] {
  const bad = commands.filter((c) => c.outcome !== 'passed');
  const good = commands.filter((c) => c.outcome === 'passed');
  return [...bad, ...good];
}
