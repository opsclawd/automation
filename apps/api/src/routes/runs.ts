import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Container } from '../compose.js';
import { serializeRun, serializeFailure, serializeJob } from '../serializers.js';
import {
  WorkerId,
  RunId,
  RepositoryId,
  RepositoryNotFoundError,
  RunStatus,
  RepositoryNotApprovedError,
  RepositoryValidationError,
  RunRepositoryMismatchError,
  RunRepositoryMissingError,
} from '@ai-sdlc/domain';
import { planRunRecoveryAction, UnknownPhaseError } from '@ai-sdlc/application';
import { resolveRepoContext, canonicalizeRepoContext } from './_lib.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_INT_RE = /^-?\d+$/;

interface ResumeRunUseCaseWithJob {
  execute(input: {
    runId: RunId;
    fromPhase?: string;
    workerId: WorkerId;
    attempt?: number;
  }): Promise<{ jobId: import('@ai-sdlc/domain').JobId; jobStatus: string }>;
}

function validateBodyObject(body: unknown): boolean {
  if (body === undefined) return true;
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

function apiWorkerId(): WorkerId {
  return WorkerId(`api-${process.pid}`);
}

export async function runsRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get('/api/meta', async (_req, _reply) => {
    return {
      repoFullName: c.repoFullName,
      targetRepoRoot: c.targetRepoRoot,
    };
  });

  async function guardMutation(
    req: FastifyRequest<{ Params: { runId: string } }>,
    reply: FastifyReply,
  ): Promise<import('@ai-sdlc/domain').Run | null> {
    const runId = req.params.runId;
    const run = c.runRepository.findByUuid(runId);
    if (!run) {
      reply.code(404).send({ error: 'not_found' });
      return null;
    }
    const ctx = resolveRepoContext(
      { headers: req.headers, query: (req.query ?? {}) as Record<string, unknown> },
      c,
      { allowFallback: false },
    );
    let resolvedRepoId: RepositoryId | undefined;
    if (ctx.repositoryId || ctx.fullName) {
      try {
        resolvedRepoId = canonicalizeRepoContext(ctx, c);
      } catch (err) {
        if (err instanceof RepositoryNotFoundError) {
          reply.code(404).send({ error: 'not_found' });
          return null;
        }
        throw err;
      }
    }
    try {
      c.loadRepositoryForRun.execute({
        run,
        ...(resolvedRepoId ? { callerRepoId: resolvedRepoId } : {}),
        strictMatch: true,
      });
    } catch (err) {
      if (err instanceof RunRepositoryMismatchError) {
        reply.code(404).send({ error: 'not_found' });
        return null;
      }
      if (err instanceof RunRepositoryMissingError) {
        reply.code(409).send({ error: 'repository_missing' });
        return null;
      }
      throw err;
    }
    return run;
  }

  app.post<{
    Body: {
      issueNumber?: unknown;
      repositoryId?: string;
      repo?: string;
      baseBranch?: string;
    };
  }>('/api/runs', async (req, reply) => {
    const body = req.body ?? {};
    const issueNumber = Number(body.issueNumber);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return reply.code(400).send({ error: 'invalid_issue_number' });
    }
    const ctx = resolveRepoContext(
      { headers: req.headers, query: (req.query ?? {}) as Record<string, unknown> },
      c,
    );
    let repositoryId =
      ctx.repositoryId ?? (body.repositoryId ? RepositoryId(body.repositoryId) : undefined);
    const fullName = ctx.fullName ?? body.repo;
    if (!repositoryId && fullName) {
      try {
        const repo = c.inspectRepository.executeByFullName(fullName);
        repositoryId = repo.id;
      } catch (err) {
        if (err instanceof RepositoryNotFoundError) {
          return reply.code(404).send({ error: 'repository_not_found' });
        }
        throw err;
      }
    }
    try {
      const run = await c.startIssueRun.execute({
        issueNumber,
        repoId: repositoryId,
        baseBranch: typeof body.baseBranch === 'string' ? body.baseBranch : undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      return reply.code(201).send({ run });
    } catch (err) {
      if (err instanceof RepositoryNotApprovedError) {
        return reply.code(409).send({ error: 'repository_not_approved', message: err.message });
      }
      if (err instanceof RepositoryValidationError) {
        return reply.code(400).send({ error: 'missing_repository_id', message: err.message });
      }
      throw err;
    }
  });

  app.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      repositoryId?: string;
      repo?: string;
      status?: string;
    };
  }>('/api/runs', async (req, reply) => {
    const MAX_LIMIT = 100;
    if (req.query.limit !== undefined && req.query.limit !== '') {
      if (!DECIMAL_INT_RE.test(req.query.limit)) {
        return reply.code(400).send({ error: 'limit must be a positive integer' });
      }
      const n = Number(req.query.limit);
      if (!Number.isSafeInteger(n) || n < 1) {
        return reply.code(400).send({ error: 'limit must be a positive integer' });
      }
    }
    if (req.query.offset !== undefined && req.query.offset !== '') {
      if (!DECIMAL_INT_RE.test(req.query.offset)) {
        return reply.code(400).send({ error: 'offset must be a non-negative integer' });
      }
      const n = Number(req.query.offset);
      if (!Number.isSafeInteger(n) || n < 0) {
        return reply.code(400).send({ error: 'offset must be a non-negative integer' });
      }
    }
    const limit =
      req.query.limit !== undefined && req.query.limit !== ''
        ? Math.min(Math.max(1, Number(req.query.limit)), MAX_LIMIT)
        : 25;
    const offset =
      req.query.offset !== undefined && req.query.offset !== ''
        ? Math.max(0, Number(req.query.offset))
        : 0;

    let repositoryId: RepositoryId | undefined;
    try {
      const ctx = resolveRepoContext({ headers: req.headers, query: req.query }, c);
      if (ctx.repositoryId || ctx.fullName) {
        repositoryId = canonicalizeRepoContext(ctx, c);
      }
    } catch (err) {
      if (err instanceof RepositoryNotFoundError) {
        return reply.code(404).send({ error: 'repository_not_found' });
      }
      throw err;
    }

    const status =
      typeof req.query.status === 'string' ? (req.query.status as RunStatus) : undefined;
    const filter: {
      limit?: number;
      offset?: number;
      repositoryId?: RepositoryId;
      status?: RunStatus;
    } = {
      limit,
      offset,
    };
    if (repositoryId !== undefined) {
      filter.repositoryId = repositoryId;
    }
    if (status !== undefined) {
      filter.status = status;
    }
    const { runs, total } = c.runRepository.list(filter);
    return {
      runs: runs.map(serializeRun),
      total,
      limit,
      offset,
    };
  });

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    if (!UUID_RE.test(req.params.runId)) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    const run = c.runRepository.findByUuid(req.params.runId);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    const failure = c.failureRepository.findLatestByRun(req.params.runId);
    return { run: serializeRun(run), failure: failure ? serializeFailure(failure) : null };
  });

  app.post<{ Params: { runId: string } }>('/api/runs/:runId/cancel', async (req, reply) => {
    if (!UUID_RE.test(req.params.runId)) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    if (!validateBodyObject(req.body)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.reason !== undefined && typeof body.reason !== 'string') {
      return reply.code(400).send({ error: 'invalid_body' });
    }

    try {
      const run = await guardMutation(req, reply);
      if (!run) return;

      const phases = c.phaseRepository.listByRun(req.params.runId);
      const plan = planRunRecoveryAction({ action: 'cancel', run, phases });
      if (!plan.allowed) {
        return reply.code(409).send({ error: 'denied', message: plan.denialReason });
      }

      await c.cancelRun.execute({
        runId: RunId(req.params.runId),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      });

      const refetchedRun = c.runRepository.findByUuid(req.params.runId);
      return reply.code(200).send({
        run: refetchedRun ? serializeRun(refetchedRun) : null,
        action: 'cancel',
      });
    } catch (err) {
      if (err instanceof UnknownPhaseError) {
        return reply.code(400).send({ error: 'unknown_phase', message: err.message });
      }
      if (err instanceof Error) {
        if (err.message.includes('No run found') || err.message.includes('no run found')) {
          return reply.code(404).send({ error: 'not_found', message: err.message });
        }
        if (
          err.message.includes('concurrent modification') ||
          err.message.includes('Cannot resume') ||
          err.message.includes('Cannot cancel') ||
          err.message.includes('Cannot retry')
        ) {
          return reply.code(409).send({ error: 'denied', message: err.message });
        }
        return reply.code(500).send({ error: 'unexpected_error', message: err.message });
      }
      return reply.code(500).send({ error: 'unexpected_error', message: String(err) });
    }
  });

  app.post<{ Params: { runId: string } }>('/api/runs/:runId/retry', async (req, reply) => {
    if (!UUID_RE.test(req.params.runId)) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    if (!validateBodyObject(req.body)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.confirm !== undefined && typeof body.confirm !== 'boolean') {
      return reply.code(400).send({ error: 'invalid_body' });
    }

    try {
      const run = await guardMutation(req, reply);
      if (!run) return;

      const phases = c.phaseRepository.listByRun(req.params.runId);
      const plan = planRunRecoveryAction({ action: 'retry', run, phases });

      if (!plan.allowed) {
        return reply.code(409).send({ error: 'denied', message: plan.denialReason });
      }

      if (plan.requiresConfirmation && !body.confirm) {
        return reply.code(409).send({
          error: 'confirmation_required',
          requiresConfirmation: true,
          action: 'retry',
          targetPhase: plan.targetPhase,
          retrySafety: 'unsafe',
          message: 'Retrying this phase can duplicate side effects. Confirm to continue.',
        });
      }

      const resumeRun = c.resumeRun as unknown as ResumeRunUseCaseWithJob;
      const result = await resumeRun.execute({
        runId: RunId(req.params.runId),
        workerId: apiWorkerId(),
        ...(plan.targetPhase !== undefined ? { fromPhase: plan.targetPhase } : {}),
        ...(plan.attempt !== undefined ? { attempt: plan.attempt } : {}),
      });

      const refetchedRun = c.runRepository.findByUuid(req.params.runId);
      const job = c.jobQueue.findById(result.jobId);

      return reply.code(202).send({
        run: refetchedRun ? serializeRun(refetchedRun) : null,
        action: 'retry',
        targetPhase: plan.targetPhase,
        requiresConfirmation: false,
        job: job ? serializeJob(job) : null,
      });
    } catch (err) {
      if (err instanceof UnknownPhaseError) {
        return reply.code(400).send({ error: 'unknown_phase', message: err.message });
      }
      if (err instanceof Error) {
        if (err.message.includes('No run found') || err.message.includes('no run found')) {
          return reply.code(404).send({ error: 'not_found', message: err.message });
        }
        if (
          err.message.includes('concurrent modification') ||
          err.message.includes('Cannot resume') ||
          err.message.includes('Cannot cancel') ||
          err.message.includes('Cannot retry')
        ) {
          return reply.code(409).send({ error: 'denied', message: err.message });
        }
        return reply.code(500).send({ error: 'unexpected_error', message: err.message });
      }
      return reply.code(500).send({ error: 'unexpected_error', message: String(err) });
    }
  });

  app.post<{ Params: { runId: string } }>('/api/runs/:runId/resume', async (req, reply) => {
    if (!UUID_RE.test(req.params.runId)) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    if (!validateBodyObject(req.body)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.fromPhase !== undefined && typeof body.fromPhase !== 'string') {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    if (body.confirm !== undefined && typeof body.confirm !== 'boolean') {
      return reply.code(400).send({ error: 'invalid_body' });
    }

    try {
      const run = await guardMutation(req, reply);
      if (!run) return;

      const phases = c.phaseRepository.listByRun(req.params.runId);
      const plan = planRunRecoveryAction({
        action: 'resume',
        run,
        phases,
        ...(typeof body.fromPhase === 'string' ? { fromPhase: body.fromPhase } : {}),
      });

      if (!plan.allowed) {
        return reply.code(409).send({ error: 'denied', message: plan.denialReason });
      }

      if (plan.requiresConfirmation && !body.confirm) {
        return reply.code(409).send({
          error: 'confirmation_required',
          requiresConfirmation: true,
          action: 'resume',
          targetPhase: plan.targetPhase,
          retrySafety: 'unsafe',
          message: 'Retrying this phase can duplicate side effects. Confirm to continue.',
        });
      }

      const hasFromPhase = body.fromPhase !== undefined;
      const resumeRun = c.resumeRun as unknown as ResumeRunUseCaseWithJob;
      const result = await resumeRun.execute({
        runId: RunId(req.params.runId),
        workerId: apiWorkerId(),
        ...(hasFromPhase && plan.targetPhase !== undefined ? { fromPhase: plan.targetPhase } : {}),
        ...(hasFromPhase && plan.attempt !== undefined ? { attempt: plan.attempt } : {}),
      });

      const refetchedRun = c.runRepository.findByUuid(req.params.runId);
      const job = c.jobQueue.findById(result.jobId);

      return reply.code(202).send({
        run: refetchedRun ? serializeRun(refetchedRun) : null,
        action: 'resume',
        targetPhase: plan.targetPhase,
        requiresConfirmation: false,
        job: job ? serializeJob(job) : null,
      });
    } catch (err) {
      if (err instanceof UnknownPhaseError) {
        return reply.code(400).send({ error: 'unknown_phase', message: err.message });
      }
      if (err instanceof Error) {
        if (err.message.includes('No run found') || err.message.includes('no run found')) {
          return reply.code(404).send({ error: 'not_found', message: err.message });
        }
        if (
          err.message.includes('concurrent modification') ||
          err.message.includes('Cannot resume') ||
          err.message.includes('Cannot cancel') ||
          err.message.includes('Cannot retry')
        ) {
          return reply.code(409).send({ error: 'denied', message: err.message });
        }
        return reply.code(500).send({ error: 'unexpected_error', message: err.message });
      }
      return reply.code(500).send({ error: 'unexpected_error', message: String(err) });
    }
  });
}
