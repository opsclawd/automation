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

// Server Components fetch directly against the API origin; the browser uses
// Next's /api/* rewrite (see next.config.mjs). If you add a 'use client'
// component that calls these helpers, it will bypass the rewrite and hit
// the API directly, which requires CORS on the API (already configured).
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4319';

export async function listRuns(): Promise<RunDto[]> {
  const r = await fetch(`${apiUrl}/api/runs`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load runs: ${r.status}`);
  return (await r.json()).runs as RunDto[];
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
