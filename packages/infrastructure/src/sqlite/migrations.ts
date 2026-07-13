import { createHash } from 'node:crypto';
import type { Db } from './database.js';
import * as init from './migrations/0001-init.js';
import * as addPid from './migrations/0002-add-pid-column.js';
import * as agentInvocations from './migrations/0003-agent-invocations.js';
import * as phaseRename from './migrations/0004-phase-rename.js';
import * as validationResults from './migrations/0005-validation-results.js';
import * as prReview from './migrations/0006-pr-review.js';
import * as agentUsage from './migrations/0007-agent-usage.js';
import * as loops from './migrations/0008-loops.js';
import * as qualityReviewInvocation from './migrations/0009-quality-review-invocation.js';
import * as reviewFixRename from './migrations/0010-review-fix-rename.js';
import * as addSkippedPhases from './migrations/0011-add-skipped-phases-column.js';
import * as addStartCommitSha from './migrations/0012-add-start-commit-sha-column.js';
import * as addWorkerLeases from './migrations/0013-add-worker-leases.js';
import * as addSteps from './migrations/0014-add-steps.js';
import * as addJobs from './migrations/0015-add-jobs.js';
import * as addRepoId from './migrations/0016-add-repo-id-to-runs.js';
import * as addWorkers from './migrations/0017-add-workers.js';
import * as addClaimTtl from './migrations/0018-claimed-at-ttl.js';
import * as addCommentSeverity from './migrations/0019-add-comment-severity.js';
import * as addBaseBranch from './migrations/0020-add-base-branch-column.js';
import * as addConfigProvenance from './migrations/0021-add-config-provenance.js';
import * as createRepositories from './migrations/0022-create-repositories.js';
import * as backfillRepositoryRegistry from './migrations/0023-backfill-repository-registry.js';
import * as addInvocationMetadata from './migrations/0024-add-invocation-metadata.js';
import * as addReviewState from './migrations/0025-add-review-state.js';
import * as addCommentAttempts from './migrations/0026-add-pr-review-comment-attempts.js';
import * as repoScopedQueue from './migrations/0027-repository-scoped-queue.js';

export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: init.version, sql: init.sql },
  { version: addPid.version, sql: addPid.sql },
  { version: agentInvocations.version, sql: agentInvocations.sql },
  { version: phaseRename.version, sql: phaseRename.sql },
  { version: validationResults.version, sql: validationResults.sql },
  { version: prReview.version, sql: prReview.sql },
  { version: agentUsage.version, sql: agentUsage.sql },
  { version: loops.version, sql: loops.sql },
  { version: qualityReviewInvocation.version, sql: qualityReviewInvocation.sql },
  { version: reviewFixRename.version, sql: reviewFixRename.sql },
  { version: addSkippedPhases.version, sql: addSkippedPhases.sql },
  { version: addStartCommitSha.version, sql: addStartCommitSha.sql },
  { version: addWorkerLeases.version, sql: addWorkerLeases.sql },
  { version: addSteps.version, sql: addSteps.sql },
  { version: addJobs.version, sql: addJobs.sql },
  { version: addRepoId.version, sql: addRepoId.sql },
  { version: addWorkers.version, sql: addWorkers.sql },
  { version: addClaimTtl.version, sql: addClaimTtl.sql },
  { version: addCommentSeverity.version, sql: addCommentSeverity.sql },
  { version: addBaseBranch.version, sql: addBaseBranch.sql },
  { version: addConfigProvenance.version, sql: addConfigProvenance.sql },
  { version: createRepositories.version, sql: createRepositories.sql },
  { version: backfillRepositoryRegistry.version, sql: backfillRepositoryRegistry.sql },
  { version: addInvocationMetadata.version, sql: addInvocationMetadata.sql },
  { version: addReviewState.version, sql: addReviewState.sql },
  { version: addCommentAttempts.version, sql: addCommentAttempts.sql },
  { version: repoScopedQueue.version, sql: repoScopedQueue.sql },
];

export function registerCustomFunctions(db: Db): void {
  db.function('sha256', (val: string) => createHash('sha256').update(val).digest());
}

export function applyMigrations(db: Db): void {
  registerCustomFunctions(db);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );

  const apply = db.transaction((version: number, sql: string) => {
    db.exec(sql);
    db.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      version,
      new Date().toISOString(),
    );
  });

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    apply(m.version, m.sql);
  }
}
