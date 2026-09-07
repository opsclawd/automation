import type { ArtifactStore } from '../../ports/artifact-store.js';

export interface FormatValidationFailuresOptions {
  maxArtifacts?: number;
  maxLinesPerArtifact?: number;
  maxBytesPerArtifact?: number;
  totalBudgetBytes?: number;
}

const DEFAULT_MAX_ARTIFACTS = 8;
const DEFAULT_MAX_LINES_PER_ARTIFACT = 100;
const DEFAULT_MAX_BYTES_PER_ARTIFACT = 8192; // 8 KB
const DEFAULT_TOTAL_BUDGET_BYTES = 24576; // 24 KB

function capBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.byteLength <= maxBytes) return text;
  return buf.subarray(buf.byteLength - maxBytes).toString('utf-8');
}

function neutralizeBackticks(text: string): string {
  return text.replace(/`{3,}/g, (match) => '\uFF40'.repeat(match.length));
}

export async function formatValidationFailures(
  failureJson: string,
  artifacts: ArtifactStore,
  runUuid: string,
  opts: FormatValidationFailuresOptions = {},
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(failureJson);
  } catch {
    return failureJson;
  }

  if (!parsed || typeof parsed !== 'object') {
    return failureJson;
  }

  const failureObj = parsed as { message?: unknown; artifacts?: unknown };
  const message = typeof failureObj.message === 'string' ? failureObj.message : failureJson;

  const rawArtifacts = Array.isArray(failureObj.artifacts) ? failureObj.artifacts : [];
  const logPaths = rawArtifacts.filter(
    (p): p is string => typeof p === 'string' && p.endsWith('.log'),
  );

  if (logPaths.length === 0) {
    return message;
  }

  const maxArtifacts = opts.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS;
  const maxLines = opts.maxLinesPerArtifact ?? DEFAULT_MAX_LINES_PER_ARTIFACT;
  const maxBytes = opts.maxBytesPerArtifact ?? DEFAULT_MAX_BYTES_PER_ARTIFACT;
  const totalBudget = opts.totalBudgetBytes ?? DEFAULT_TOTAL_BUDGET_BYTES;

  interface CandidateSection {
    path: string;
    content: string;
    isUnreadable?: boolean;
  }

  const candidates: CandidateSection[] = [];

  for (const path of logPaths) {
    let content: string;
    let isUnreadable = false;
    try {
      content = await artifacts.read(runUuid, path);
    } catch {
      isUnreadable = true;
      content = '(artifact unreadable)';
    }

    if (!isUnreadable) {
      if (content.trim() === '') {
        continue;
      }
      const lines = content.split('\n');
      const tailed = lines.slice(-maxLines).join('\n');
      const capped = capBytes(tailed, maxBytes);
      content = neutralizeBackticks(capped);
    }

    candidates.push({ path, content, isUnreadable });
  }

  if (candidates.length === 0) {
    return message;
  }

  const sections: string[] = [];
  let currentBytes = Buffer.byteLength(message, 'utf-8');

  for (let i = 0; i < candidates.length; i++) {
    if (sections.length >= maxArtifacts) {
      const omitted = candidates.length - i;
      sections.push(`...${omitted} more log artifact(s) omitted (budget exceeded)`);
      break;
    }

    const candidate = candidates[i];
    if (!candidate) continue;
    const header = candidate.isUnreadable
      ? `--- ${candidate.path} ---`
      : `--- ${candidate.path} (last ${maxLines} lines) ---`;
    const sectionText = `${header}\n${candidate.content}`;
    const sectionBytes = Buffer.byteLength(sectionText, 'utf-8') + 2; // account for '\n\n' separator

    if (currentBytes + sectionBytes > totalBudget) {
      const omitted = candidates.length - i;
      sections.push(`...${omitted} more log artifact(s) omitted (budget exceeded)`);
      break;
    }

    sections.push(sectionText);
    currentBytes += sectionBytes;
  }

  if (sections.length === 0) {
    return message;
  }

  if (!message) {
    return sections.join('\n\n');
  }

  return `${message}\n\n${sections.join('\n\n')}`;
}
