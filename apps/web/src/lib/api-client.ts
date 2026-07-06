import type { ApiEvent } from './timeline';
import type { PrReviewCommentDto, PollAttemptDto } from './pr-review';
import type { ValidationRunDto } from './validation';
import type { LoopDto } from './review-fix';

export interface RunDto {
  uuid: string;
  displayId: string;
  issueNumber: number;
  status: string;
  currentPhase: string | null;
  completedPhases: string[];
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  durationMs: number | null;
  failureReason: string | null;
  repoId: string;
}

export interface RepositoryDto {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  localBasePath: string;
  enabled: boolean;
  maxConcurrentRuns: number;
  createdAt: string;
  updatedAt: string;
}

export interface FailureDto {
  kind: string;
  message: string;
  phase?: string;
  exitCode?: number;
  suggestedAction: string;
  artifacts: string[];
}

// Server Components fetch directly against the API origin; client components
// should use relative `/api/...` paths so the request goes through Next's
// /api/* rewrite (see next.config.mjs) and avoids CORS issues.
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4319';

export interface ListRunsResult {
  runs: RunDto[];
  total: number;
  limit: number;
  offset: number;
}

export async function listRuns(params?: {
  limit: number;
  offset?: number;
  repoId?: string | undefined;
}): Promise<ListRunsResult> {
  const paramsArray: string[] = [];
  if (params) {
    if (params.limit !== undefined) paramsArray.push(`limit=${params.limit}`);
    if (params.offset !== undefined) paramsArray.push(`offset=${params.offset}`);
    if (params.repoId !== undefined) paramsArray.push(`repoId=${params.repoId}`);
  }
  const qs = paramsArray.length > 0 ? `?${paramsArray.join('&')}` : '';
  const r = await fetch(`${apiUrl}/api/runs${qs}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load runs: ${r.status}`);
  return r.json() as Promise<ListRunsResult>;
}

export async function getRun(uuid: string): Promise<{ run: RunDto; failure: FailureDto | null }> {
  const r = await fetch(`${apiUrl}/api/runs/${uuid}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load run: ${r.status}`);
  return r.json();
}

export interface ArtifactFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export async function listArtifacts(uuid: string): Promise<ArtifactFile[]> {
  const r = await fetch(`${apiUrl}/api/runs/${uuid}/artifacts`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load artifacts: ${r.status}`);
  return (await r.json()).files as ArtifactFile[];
}

export async function getArtifact(uuid: string, path: string): Promise<string> {
  const r = await fetch(`${apiUrl}/api/runs/${uuid}/artifacts/${encodeURIComponent(path)}`, {
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`failed to load artifact: ${r.status}`);
  return r.text();
}

export async function listRunEvents(runUuid: string, since?: string): Promise<ApiEvent[]> {
  const base = typeof window === 'undefined' ? apiUrl : '';
  const qs = since ? `?since=${encodeURIComponent(since)}` : '';
  // cache: 'no-store' only takes effect in server components (Next.js fetch extension);
  // browser fetch silently ignores it. Kept for server-side call-site correctness.
  const r = await fetch(`${base}/api/runs/${runUuid}/events${qs}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load run events: ${r.status}`);
  return ((await r.json()) as { events: ApiEvent[] }).events;
}

export async function listValidation(runUuid: string): Promise<ValidationRunDto[]> {
  const base = typeof window === 'undefined' ? apiUrl : '';
  const r = await fetch(`${base}/api/runs/${runUuid}/validation`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load validation: ${r.status}`);
  return ((await r.json()) as { validationRuns: ValidationRunDto[] }).validationRuns;
}

export interface PrReviewData {
  comments: PrReviewCommentDto[];
  pollAttempts: PollAttemptDto[];
}

export async function listPrReview(runUuid: string): Promise<PrReviewData> {
  const base = typeof window === 'undefined' ? apiUrl : '';
  const r = await fetch(`${base}/api/runs/${runUuid}/pr-review`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load pr-review: ${r.status}`);
  return (await r.json()) as PrReviewData;
}

export async function listReviewFix(runUuid: string): Promise<LoopDto[]> {
  const base = typeof window === 'undefined' ? apiUrl : '';
  const r = await fetch(`${base}/api/runs/${runUuid}/review-fix`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load review-fix: ${r.status}`);
  return ((await r.json()) as { loops: LoopDto[] }).loops;
}

export interface ListRepositoriesResult {
  repositories: RepositoryDto[];
}

export async function listRepositories(): Promise<ListRepositoriesResult> {
  const base = typeof window === 'undefined' ? apiUrl : '';
  const r = await fetch(`${base}/api/repositories`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load repositories: ${r.status}`);
  return r.json() as Promise<ListRepositoriesResult>;
}

export interface JobDto {
  id: string;
  status: string;
  runId: string;
  repoId: string;
  issueNumber: number;
  attempts: number;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunActionSuccessDto {
  run: RunDto;
  action: 'cancel' | 'retry' | 'resume';
  targetPhase?: string;
  requiresConfirmation?: false;
  job?: JobDto;
}

export interface ConfirmationRequiredDto {
  error: 'confirmation_required';
  requiresConfirmation: true;
  action: 'retry' | 'resume';
  targetPhase?: string;
  retrySafety: 'unsafe';
  message: string;
}

export class RunActionConfirmationRequiredError extends Error {
  public payload: ConfirmationRequiredDto;
  constructor(payload: ConfirmationRequiredDto) {
    super(payload.message || 'Confirmation required');
    this.name = 'RunActionConfirmationRequiredError';
    this.payload = payload;
  }
}

export async function cancelRunAction(
  runUuid: string,
  reason?: string,
): Promise<RunActionSuccessDto> {
  const base = typeof window === 'undefined' ? apiUrl : '';
  const init: RequestInit = {
    method: 'POST',
    cache: 'no-store',
  };
  if (reason !== undefined) {
    init.body = JSON.stringify({ reason });
    init.headers = { 'Content-Type': 'application/json' };
  }
  const r = await fetch(`${base}/api/runs/${runUuid}/cancel`, init);
  if (!r.ok) {
    if (r.status === 409) {
      try {
        const data = await r.json();
        if (data && data.error === 'confirmation_required') {
          throw new RunActionConfirmationRequiredError(data);
        }
      } catch (e) {
        if (e instanceof RunActionConfirmationRequiredError) {
          throw e;
        }
      }
    }
    throw new Error(`failed to cancel run action: ${r.status}`);
  }
  return r.json() as Promise<RunActionSuccessDto>;
}

export async function retryRunAction(
  runUuid: string,
  confirm?: boolean,
): Promise<RunActionSuccessDto> {
  const base = typeof window === 'undefined' ? apiUrl : '';
  const init: RequestInit = {
    method: 'POST',
    cache: 'no-store',
  };
  if (confirm !== undefined) {
    init.body = JSON.stringify({ confirm });
    init.headers = { 'Content-Type': 'application/json' };
  }
  const r = await fetch(`${base}/api/runs/${runUuid}/retry`, init);
  if (!r.ok) {
    if (r.status === 409) {
      try {
        const data = await r.json();
        if (data && data.error === 'confirmation_required') {
          throw new RunActionConfirmationRequiredError(data);
        }
      } catch (e) {
        if (e instanceof RunActionConfirmationRequiredError) {
          throw e;
        }
      }
    }
    throw new Error(`failed to retry run action: ${r.status}`);
  }
  return r.json() as Promise<RunActionSuccessDto>;
}

export async function resumeRunAction(
  runUuid: string,
  input?: { fromPhase?: string; confirm?: boolean },
): Promise<RunActionSuccessDto> {
  const base = typeof window === 'undefined' ? apiUrl : '';
  const init: RequestInit = {
    method: 'POST',
    cache: 'no-store',
  };
  const hasBody =
    input !== undefined && (input.fromPhase !== undefined || input.confirm !== undefined);
  if (hasBody) {
    init.body = JSON.stringify(input);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const r = await fetch(`${base}/api/runs/${runUuid}/resume`, init);
  if (!r.ok) {
    if (r.status === 409) {
      try {
        const data = await r.json();
        if (data && data.error === 'confirmation_required') {
          throw new RunActionConfirmationRequiredError(data);
        }
      } catch (e) {
        if (e instanceof RunActionConfirmationRequiredError) {
          throw e;
        }
      }
    }
    throw new Error(`failed to resume run action: ${r.status}`);
  }
  return r.json() as Promise<RunActionSuccessDto>;
}
