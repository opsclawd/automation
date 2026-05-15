import type { Failure } from '@ai-sdlc/domain';
import type { Db } from './database.js';

export class FailureRepository {
  constructor(private readonly db: Db) {}

  insert(failure: Failure): void {
    this.db
      .prepare(
        `INSERT INTO failures (run_uuid, phase, step, attempt, kind, message, exit_code,
          can_retry, suggested_action, artifacts, detected_at)
         VALUES (@run_uuid, @phase, @step, @attempt, @kind, @message, @exit_code,
          @can_retry, @suggested_action, @artifacts, @detected_at)`,
      )
      .run({
        run_uuid: failure.runUuid,
        phase: failure.phase ?? null,
        step: failure.step ?? null,
        attempt: failure.attempt ?? null,
        kind: failure.kind,
        message: failure.message,
        exit_code: failure.exitCode ?? null,
        can_retry: failure.canRetry ? 1 : 0,
        suggested_action: failure.suggestedAction,
        artifacts: JSON.stringify(failure.artifacts),
        detected_at: failure.detectedAt.toISOString(),
      });
  }

  findLatestByRun(runUuid: string): Failure | undefined {
    const row = this.db
      .prepare('SELECT * FROM failures WHERE run_uuid = ? ORDER BY id DESC LIMIT 1')
      .get(runUuid) as
      | {
          run_uuid: string;
          phase: string | null;
          step: string | null;
          attempt: number | null;
          kind: string;
          message: string;
          exit_code: number | null;
          can_retry: number;
          suggested_action: string;
          artifacts: string;
          detected_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      runUuid: row.run_uuid,
      phase: row.phase ?? undefined,
      step: row.step ?? undefined,
      attempt: row.attempt ?? undefined,
      kind: row.kind as Failure['kind'],
      message: row.message,
      exitCode: row.exit_code ?? undefined,
      canRetry: row.can_retry === 1,
      suggestedAction: row.suggested_action,
      artifacts: JSON.parse(row.artifacts) as string[],
      detectedAt: new Date(row.detected_at),
    };
  }
}
