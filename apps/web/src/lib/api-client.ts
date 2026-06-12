import type { ApiEvent } from './timeline';
import type { PrReviewCommentDto, PollAttemptDto } from './pr-review';
import type { ValidationRunDto } from './validation';

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
}): Promise<ListRunsResult> {
  const qs = params ? `?limit=${params.limit}&offset=${params.offset ?? 0}` : '';
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
