# M8-12: Retry / Resume / Cancel API + UI Controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the M8-10 cancel/retry/resume use cases over REST and add run-detail UI buttons. Unsafe retries (e.g. `create-pr` after a PR exists) require explicit confirmation before proceeding.

**Architecture:** Thin Fastify routes in `apps/api/src/routes/runs.ts` that enqueue work via the use cases (never execute inline, per ADR-0008) and return run/job status. The route flags `requiresConfirmation` for unsafe targets (derived from the phase registry's `retrySafety`) unless `confirm: true` is supplied. The Next.js run-detail page gains Cancel/Retry/Resume controls + a confirmation dialog.

**Tech Stack:** Fastify (API), Next.js 15 App Router + shadcn/ui (web), Vitest (API tests), Playwright (e2e).

---

## Critical context (read first)

- **Q19:** REST API is the contract; Web UI and CLI are thin clients — neither privileged.
- **ADR-0008:** endpoints **enqueue**; they never run the pipeline inline. Cancel/retry/resume produce a queued Job or a state transition + (re)enqueue.
- **Unsafe retry (PRD §12 invariant 11 / Risk 3):** `create-pr` is `retrySafety: 'unsafe'` (M8-01 registry). Retrying/resuming an unsafe phase without confirmation must be blocked. Derive "unsafe" from `getPhaseDefinition(phase).retrySafety`, not a hard-coded list.
- Use cases exist from M8-10: `CancelRunUseCase`, `RetryFailedPhaseUseCase`, `ResumeRunUseCase` (interfaces in `packages/application/src/use-cases.ts`; `CancelRun` impl in `cancel-run.ts`).
- Follow the **existing route patterns** in `apps/api/src/routes/runs.ts` (Fastify route registration, the `compose.ts` container injection, serializers in `apps/api/src/serializers.ts`). Read those files before writing.
- PRD §23.9–§23.11 specify the endpoints; §24.2 lists run-detail Actions.

## File structure

- Modify: `apps/api/src/routes/runs.ts` — add `cancel`/`retry`/`resume` routes.
- Modify: `apps/api/src/compose.ts` — expose the three use cases on the container if not already.
- Create: `apps/api/src/routes/__tests__/run-actions.test.ts`
- Modify: `apps/web/src/app/runs/[id]/...` — Actions UI + confirmation dialog.
- Create: `apps/web/e2e/run-resume.spec.ts`

---

### Task 1: API routes (TDD with the existing route test harness)

**Files:**
- Modify: `apps/api/src/routes/runs.ts`
- Test: `apps/api/src/routes/__tests__/run-actions.test.ts`

- [ ] **Step 1: Read** `apps/api/src/routes/runs.ts` and an existing route test (e.g. how `GET /api/runs` is tested) to copy the Fastify `inject` test pattern and container-injection style.

- [ ] **Step 2: Write the failing test** (adapt to the repo's harness):

```ts
import { describe, it, expect } from 'vitest';
import { buildTestServer } from '../../__tests__/helpers.js'; // use the repo's existing helper

describe('run action routes', () => {
  it('POST /api/runs/:id/cancel enqueues cancel and returns status', async () => {
    const { app, fakes } = await buildTestServer();
    // seed a running run in fakes.runRepo ...
    const res = await app.inject({ method: 'POST', url: '/api/runs/u1/cancel', payload: {} });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBeDefined();
  });

  it('POST /api/runs/:id/resume {fromPhase} blocks unsafe phase without confirm', async () => {
    const { app } = await buildTestServer();
    const res = await app.inject({ method: 'POST', url: '/api/runs/u1/resume', payload: { fromPhase: 'create-pr' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().requiresConfirmation).toBe(true);
  });

  it('proceeds when confirm:true is supplied for an unsafe phase', async () => {
    const { app } = await buildTestServer();
    const res = await app.inject({ method: 'POST', url: '/api/runs/u1/resume', payload: { fromPhase: 'create-pr', confirm: true } });
    expect(res.statusCode).toBe(202);
  });
});
```

> If no `buildTestServer` helper exists, create a minimal one that builds the Fastify app with fake use cases. Match the existing test conventions.

- [ ] **Step 3: Run → FAIL.** `pnpm exec vitest run apps/api/src/routes/__tests__/run-actions.test.ts`

- [ ] **Step 4: Implement the routes** in `runs.ts` (sketch — adapt to the file's existing style):

```ts
import { getPhaseDefinition } from '@ai-sdlc/application';

// inside the route plugin, with `container` injected:
app.post('/api/runs/:id/cancel', async (req, reply) => {
  const { id } = req.params as { id: string };
  await container.cancelRun.execute({ runId: id as never });
  return reply.code(202).send({ runId: id, status: 'cancelling' });
});

app.post('/api/runs/:id/retry', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { confirm } = (req.body ?? {}) as { confirm?: boolean };
  const run = container.runRepository.findByUuid(id);
  const phase = run?.currentPhase ?? undefined;
  if (phase && isUnsafe(phase) && !confirm) {
    return reply.code(409).send({ requiresConfirmation: true, phase, reason: 'retrying this phase may duplicate side effects' });
  }
  await container.retryFailedPhase.execute({ runId: id as never });
  return reply.code(202).send({ runId: id, status: 'queued' });
});

app.post('/api/runs/:id/resume', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { fromPhase, confirm } = (req.body ?? {}) as { fromPhase?: string; confirm?: boolean };
  if (fromPhase && isUnsafe(fromPhase) && !confirm) {
    return reply.code(409).send({ requiresConfirmation: true, phase: fromPhase, reason: 'resuming from this phase may duplicate side effects' });
  }
  await container.resumeRun.execute({ runId: id as never, ...(fromPhase ? { fromPhase } : {}) });
  return reply.code(202).send({ runId: id, status: 'queued' });
});

function isUnsafe(phase: string): boolean {
  try {
    return getPhaseDefinition(phase as never).retrySafety === 'unsafe';
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: Commit** `git add -A && git commit -m "feat(api): cancel/retry/resume routes with unsafe-retry confirmation"`

---

### Task 2: Wire use cases on the container (if not already)

**Files:**
- Modify: `apps/api/src/compose.ts`

- [ ] **Step 1:** Ensure the container exposes `cancelRun`, `retryFailedPhase`, `resumeRun` (implementations from M8-10). Add them if absent.
- [ ] **Step 2:** `pnpm exec vitest run apps/api/src/__tests__/compose.test.ts` → PASS (extend the compose test to assert the new members exist).
- [ ] **Step 3: Commit** `git add -A && git commit -m "feat(api): expose run action use cases on the container"`

---

### Task 3: Run-detail UI controls + confirmation dialog

**Files:**
- Modify: `apps/web/src/app/runs/[id]/` (the run-detail page / a new `run-actions.tsx` client component)

- [ ] **Step 1:** Read the existing run-detail page to match component/style conventions (shadcn/ui Button/Dialog).

- [ ] **Step 2: Add a client `RunActions` component** with Cancel / Retry / Resume buttons. Resume offers a phase selector (default: resume from failed step; option: restart a phase). Buttons disable while a request is in flight and reflect valid actions for the run's status (e.g. Cancel only when `running`/`waiting`).

- [ ] **Step 3: Confirmation dialog:** when the API returns `409 { requiresConfirmation: true }`, open a dialog explaining the duplicate-side-effect risk; on confirm, re-POST with `confirm: true`.

- [ ] **Step 4:** Component test (or rely on the e2e in Task 4). Lint + typecheck the web package.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(web): run-detail Cancel/Retry/Resume controls + confirm dialog"`

---

### Task 4: End-to-end resume scenario (the acceptance scenario)

**Files:**
- Create: `apps/web/e2e/run-resume.spec.ts`

- [ ] **Step 1: Write the Playwright e2e** (model on `apps/web/e2e/run-detail-timeline.spec.ts`): seed a run **failed at `review-fix`**, open the run-detail page, click **Resume**, and assert the run progresses to completion. Use the same seeding/fixtures approach the existing e2e specs use.

- [ ] **Step 2: Run the e2e** per the repo's e2e command (check `apps/web/package.json` for the Playwright script). Iterate until green.

- [ ] **Step 3: Full sweep:** `pnpm -r typecheck && pnpm lint && pnpm test`.

- [ ] **Step 4: Commit** `git add -A && git commit -m "test(web): e2e resume from review-fix to completion"`

---

## Self-review checklist

- [ ] Acceptance → tests: 3 endpoints exist + resume takes `fromPhase` (Task 1), unsafe-without-confirm blocked / with-confirm proceeds (Task 1), UI controls reflect state (Task 3), confirm dialog only for unsafe (Task 3), e2e resume-from-review-fix completes (Task 4).
- [ ] API-first: routes enqueue, never execute inline; UI is a thin client.
- [ ] "Unsafe" derived from `getPhaseDefinition().retrySafety`, not hard-coded.
- [ ] Double-submit guarded in the UI.

## Definition of done

Merged with green CI; API-first with thin UI; unsafe-retry confirmation enforced; the resume-from-`review-fix` e2e passes.
