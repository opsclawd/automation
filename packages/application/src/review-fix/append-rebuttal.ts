import { ORCHESTRATOR_ARTIFACT_PATHS } from '../artifacts/orchestrator-artifacts.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { FindingEvidence } from '../ports/finding-evidence-inspector-port.js';

export interface AppendRebuttalInput {
  readonly runId: string;
  readonly phaseId: string;
  readonly iterationIndex: number;
  readonly rebuttal: string;
  readonly unfoundedFindings: ReadonlyArray<{
    readonly severity: string;
    readonly summary: string;
    readonly evidence?: FindingEvidence;
  }>;
}

export interface AppendRebuttalResult {
  readonly written: boolean;
  readonly path: string;
  readonly reason?: string;
}

/**
 * Append an accepted rebuttal section to `code-review.md` so the human /
 * PR-review stage sees what was disputed. Reads the existing file via
 * `ArtifactStore.read`, appends a `## Accepted Rebuttal (iteration N)`
 * block, and writes it back via `ArtifactStore.write`.
 *
 * Never throws: returns `written: false` with a `reason` on any failure so
 * the loop can emit a `review.rebuttal.append_skipped` event and continue.
 */
export async function appendRebuttalToCodeReview(
  artifactStore: ArtifactStore,
  input: AppendRebuttalInput,
): Promise<AppendRebuttalResult> {
  const path = 'code-review.md';
  if (!ORCHESTRATOR_ARTIFACT_PATHS.includes(path as never)) {
    // Should never happen — defensive check that the path is in the allow-list.
    return {
      written: false,
      path,
      reason: 'code-review.md not in orchestrator artifact allow-list',
    };
  }

  let existing = '';
  try {
    existing = await artifactStore.read(input.runId, path);
  } catch {
    // File may not exist yet — start with empty body.
    existing = '';
  }

  const section = renderRebuttalSection(input);
  const updated = existing.length > 0 ? `${existing}\n\n${section}\n` : `${section}\n`;

  try {
    await artifactStore.write({
      runId: input.runId,
      ...(input.phaseId !== undefined ? { phaseId: input.phaseId } : {}),
      relativePath: path,
      contents: updated,
    });
    return { written: true, path };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { written: false, path, reason };
  }
}

function renderRebuttalSection(input: AppendRebuttalInput): string {
  const lines: string[] = [];
  lines.push(`## Accepted Rebuttal (iteration ${input.iterationIndex})`);
  lines.push('');
  lines.push(input.rebuttal);
  lines.push('');
  lines.push('### Unfounded findings (mechanical evidence check failed)');
  lines.push('');
  for (const f of input.unfoundedFindings) {
    const ev = f.evidence;
    const evDesc =
      ev === undefined
        ? '(no evidence extracted)'
        : ev.line !== undefined
          ? `${ev.path}:${ev.line}`
          : ev.path !== undefined && ev.path !== ''
            ? ev.path
            : '(no path)';
    lines.push(`- **[${f.severity}]** ${f.summary} — evidence: \`${evDesc}\``);
  }
  return lines.join('\n');
}
