import type { ApiEvent } from './timeline';
import type { PrReviewCommentDto, PollAttemptDto } from './pr-review';
import type { ValidationRunDto } from './validation';
import type { LoopDto } from './review-fix';

export interface RunDto {
  uuid: string;
  displayId: string;
  issueNumber: number;
  repoId: string;
  status: string;
  currentPhase: string | null;
  completedPhases: string[];
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  durationMs: number | null;
  failureReason: string | null;
}

export interface RepositoryDto {
  id: string;
  fullName: string;
  owner: string;
  name: string;
  localBasePath: string;
  defaultBranch: string;
  remoteUrl: string;
  enabled: boolean;
  healthStatus: 'unknown' | 'healthy' | 'degraded' | 'unreachable';
  healthError: string | null;
  lastHealthCheckAt: string | null;
  configMetadata: string;
  createdAt: string;
  updatedAt: string;
}

export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'passed',
  'failed',
  'cancelled',
  'blocked',
  'needs_human_review',
] as const;

export const repositoryHref = (repositoryId: string) =>
  `/repositories/${encodeURIComponent(repositoryId)}`;
export const repositoryRunHref = (repositoryId: string, uuid: string) =>
  `${repositoryHref(repositoryId)}/runs/${encodeURIComponent(uuid)}`;

export interface FailureDto {
  kind: string;
  message: string;
  phase?: string;
  exitCode?: number;
  suggestedAction: string;
  artifacts: string[];
}

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4319';

export interface MetaDto {
  repoFullName: string;
  targetRepoRoot: string;
}

export async function getMeta(): Promise<MetaDto> {
  const base = typeof window === 'undefined' ? apiUrl : '';
  const r = await fetch(`${base}/api/meta`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load meta: ${r.status}`);
  return r.json() as Promise<MetaDto>;
}

export interface ListRunsResult {
  runs: RunDto[];
  total: number;
  limit: number;
  offset: number;
}

function getRequestUrl(
  path: string,
  params: Record<string, string | number | undefined | null> = {},
): string {
  const base = typeof window === 'undefined' ? apiUrl : '';
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      search.append(k, String(v));
    }
  }
  const qs = search.toString();
  return `${base}${path}${qs ? `?${qs}` : ''}`;
}

export async function listRuns(params?: {
  limit: number;
  offset?: number;
  repositoryId?: string;
  status?: string;
}): Promise<ListRunsResult> {
  const url = getRequestUrl('/api/runs', {
    limit: params?.limit,
    offset: params?.offset ?? 0,
    repositoryId: params?.repositoryId,
    status: params?.status,
  });
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load runs: ${r.status}`);
  return r.json() as Promise<ListRunsResult>;
}

export async function getRun(
  repositoryId: string,
  uuid: string,
): Promise<{ run: RunDto; failure: FailureDto | null }> {
  const url = getRequestUrl(`/api/runs/${uuid}`, { repositoryId });
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load run: ${r.status}`);
  return r.json();
}

export interface ArtifactFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export async function listArtifacts(repositoryId: string, uuid: string): Promise<ArtifactFile[]> {
  const url = getRequestUrl(`/api/runs/${uuid}/artifacts`, { repositoryId });
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load artifacts: ${r.status}`);
  return (await r.json()).files as ArtifactFile[];
}

export async function getArtifact(
  repositoryId: string,
  uuid: string,
  path: string,
): Promise<string> {
  const url = getRequestUrl(`/api/runs/${uuid}/artifacts/${encodeURIComponent(path)}`, {
    repositoryId,
  });
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load artifact: ${r.status}`);
  return r.text();
}

export async function listRunEvents(
  repositoryId: string,
  runUuid: string,
  since?: string,
): Promise<ApiEvent[]> {
  const url = getRequestUrl(`/api/runs/${runUuid}/events`, {
    repositoryId,
    since,
  });
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load run events: ${r.status}`);
  return ((await r.json()) as { events: ApiEvent[] }).events;
}

export async function listValidation(
  repositoryId: string,
  runUuid: string,
): Promise<ValidationRunDto[]> {
  const url = getRequestUrl(`/api/runs/${runUuid}/validation`, { repositoryId });
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load validation: ${r.status}`);
  return ((await r.json()) as { validationRuns: ValidationRunDto[] }).validationRuns;
}

export interface PrReviewData {
  comments: PrReviewCommentDto[];
  pollAttempts: PollAttemptDto[];
}

export async function listPrReview(repositoryId: string, runUuid: string): Promise<PrReviewData> {
  const url = getRequestUrl(`/api/runs/${runUuid}/pr-review`, { repositoryId });
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load pr-review: ${r.status}`);
  return (await r.json()) as PrReviewData;
}

export async function listReviewFix(repositoryId: string, runUuid: string): Promise<LoopDto[]> {
  const url = getRequestUrl(`/api/runs/${runUuid}/review-fix`, { repositoryId });
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load review-fix: ${r.status}`);
  return ((await r.json()) as { loops: LoopDto[] }).loops;
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
  repositoryId: string,
  runUuid: string,
  reason?: string,
): Promise<RunActionSuccessDto> {
  const url = getRequestUrl(`/api/runs/${runUuid}/cancel`, { repositoryId });
  const init: RequestInit = {
    method: 'POST',
    cache: 'no-store',
  };
  if (reason !== undefined) {
    init.body = JSON.stringify({ reason });
    init.headers = { 'Content-Type': 'application/json' };
  }
  const r = await fetch(url, init);
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
  repositoryId: string,
  runUuid: string,
  confirm?: boolean,
): Promise<RunActionSuccessDto> {
  const url = getRequestUrl(`/api/runs/${runUuid}/retry`, { repositoryId });
  const init: RequestInit = {
    method: 'POST',
    cache: 'no-store',
  };
  if (confirm !== undefined) {
    init.body = JSON.stringify({ confirm });
    init.headers = { 'Content-Type': 'application/json' };
  }
  const r = await fetch(url, init);
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
  repositoryId: string,
  runUuid: string,
  input?: { fromPhase?: string; confirm?: boolean },
): Promise<RunActionSuccessDto> {
  const url = getRequestUrl(`/api/runs/${runUuid}/resume`, { repositoryId });
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
  const r = await fetch(url, init);
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

export async function listRepositories(params?: { all?: number }): Promise<RepositoryDto[]> {
  const url = getRequestUrl('/api/repositories', params);
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load repositories: ${r.status}`);
  return r.json() as Promise<RepositoryDto[]>;
}

export async function getRepository(id: string): Promise<RepositoryDto> {
  const url = getRequestUrl(`/api/repositories/${id}`);
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load repository: ${r.status}`);
  return r.json() as Promise<RepositoryDto>;
}

export async function refreshRepositoryHealth(id: string): Promise<RepositoryDto> {
  const url = getRequestUrl(`/api/repositories/${id}/refresh`);
  const r = await fetch(url, { method: 'POST', cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to refresh repository health: ${r.status}`);
  return r.json() as Promise<RepositoryDto>;
}

export async function startRun(
  repositoryId: string,
  issueNumber: number,
): Promise<{ run: RunDto }> {
  const url = getRequestUrl('/api/runs');
  const r = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repositoryId, issueNumber }),
  });
  if (!r.ok) throw new Error(`failed to start run: ${r.status}`);
  return r.json() as Promise<{ run: RunDto }>;
}

export async function getStatusMetrics(repositoryId: string): Promise<Record<string, number>> {
  const promises = RUN_STATUSES.map(async (status) => {
    const res = await listRuns({ repositoryId, status, limit: 1 });
    return { status, total: res.total };
  });
  const results = await Promise.all(promises);
  const metrics: Record<string, number> = {};
  for (const r of results) {
    metrics[r.status] = r.total;
  }
  return metrics;
}
