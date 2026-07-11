import { z } from 'zod';
import type { EvidenceResolver, PlanReviewFinding } from './types.js';

const verdictSchema = z.enum(['pass', 'p1_found', 'p2_only', 'proceed_with_concerns']);
const severitySchema = z.enum(['P0', 'P1', 'P2']);
const evidenceSchema = z.enum(['grounded', 'ungrounded']);
const dispositionSchema = z.enum(['addressed', 'rebutted', 'still_open', 'never_seen_again']);

export const planReviewFindingSchema = z.object({
  severity: severitySchema,
  citation: z.string().trim().min(1),
  failureScenario: z.string().trim().min(1),
  evidence: evidenceSchema,
  disposition: dispositionSchema.optional(),
});

export const planReviewFindingsSchema = z.object({
  verdict: verdictSchema,
  knownLimitations: z.array(z.string().trim().min(1)).optional(),
  findings: z.array(planReviewFindingSchema),
});

export type PlanReviewFindingsDocument = z.infer<typeof planReviewFindingsSchema>;

export class PlanReviewFindingsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanReviewFindingsParseError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const SECTION_HEADING_RE = /^##\s+(verdict|known_limitations|findings)\s*$/i;
const FINDING_LINE_RE = /^[-*]\s+\[(P[0-3])\]\s+(.*)$/i;
const BULLET_LINE_RE = /^[-*]\s+(.*)$/;

function normalizeLines(markdown: string): string[] {
  return markdown
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd());
}

function readSection(lines: string[], sectionName: string): { found: boolean; body: string[] } {
  const sectionIndex = lines.findIndex((line) => {
    const match = SECTION_HEADING_RE.exec(line.trim());
    return match !== null && match[1]!.toLowerCase() === sectionName;
  });
  if (sectionIndex === -1) {
    return { found: false, body: [] };
  }
  const body: string[] = [];
  for (let i = sectionIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (SECTION_HEADING_RE.test(line.trim())) {
      break;
    }
    body.push(line);
  }
  return { found: true, body };
}

function extractSectionLines(lines: string[], sectionName: string): string[] {
  const section = readSection(lines, sectionName);
  if (!section.found) {
    throw new PlanReviewFindingsParseError(`missing ## ${sectionName} section`);
  }
  return section.body;
}

function maybeExtractSectionLines(lines: string[], sectionName: string): string[] | undefined {
  const section = readSection(lines, sectionName);
  return section.found ? section.body : undefined;
}

function wrapParseError(message: string): never {
  throw new PlanReviewFindingsParseError(message);
}

function parseVerdictToken(text: string): PlanReviewFindingsDocument['verdict'] {
  const parsed = verdictSchema.safeParse(text.trim());
  if (!parsed.success) {
    wrapParseError(`invalid verdict value: ${text.trim() || '(empty)'}`);
  }
  return parsed.data;
}

function parseSeverityToken(text: string): PlanReviewFinding['severity'] {
  const parsed = severitySchema.safeParse(text.trim().toUpperCase());
  if (!parsed.success) {
    wrapParseError(`invalid severity token: ${text.trim() || '(empty)'}`);
  }
  return parsed.data;
}

function normalizeEnumToken(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function parseEvidenceToken(text: string): PlanReviewFinding['evidence'] {
  const normalized = normalizeEnumToken(text);
  if (
    normalized === 'grounded' ||
    normalized === 'confirmed' ||
    normalized === 'resolved' ||
    normalized === 'true' ||
    normalized === 'yes'
  ) {
    return 'grounded';
  }
  if (
    normalized === 'ungrounded' ||
    normalized === 'unconfirmed' ||
    normalized === 'unresolved' ||
    normalized === 'false' ||
    normalized === 'no'
  ) {
    return 'ungrounded';
  }
  wrapParseError(`invalid evidence token: ${text.trim() || '(empty)'}`);
}

function parseDispositionToken(text: string): PlanReviewFinding['disposition'] | undefined {
  const normalized = normalizeEnumToken(text);
  if (normalized.length === 0) {
    return undefined;
  }
  const parsed = dispositionSchema.safeParse(normalized);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

function splitDelimitedFindingBody(body: string): {
  citation: string;
  failureScenario: string;
  evidence: string;
  disposition?: string;
} {
  const parts = body
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length < 3) {
    wrapParseError('findings section entries must use citation | failureScenario | evidence');
  }

  const lastPart = parts.at(-1)!;
  const maybeDisposition = parseDispositionToken(lastPart);
  if (maybeDisposition !== undefined && parts.length >= 4) {
    return {
      citation: parts[0]!,
      failureScenario: parts.slice(1, -2).join(' | ').trim(),
      evidence: parts.at(-2)!,
      disposition: maybeDisposition,
    };
  }

  return {
    citation: parts[0]!,
    failureScenario: parts.slice(1, -1).join(' | ').trim(),
    evidence: lastPart,
  };
}

function splitUnDelimitedFindingBody(lines: string[]): {
  citation: string;
  failureScenario: string;
  evidence: string;
  disposition?: string;
} {
  if (lines.length < 3) {
    wrapParseError('findings section entries must use citation, failureScenario, and evidence');
  }

  const trimmed = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  const lastLine = trimmed.at(-1)!;
  const maybeDisposition = parseDispositionToken(lastLine);
  if (maybeDisposition !== undefined && trimmed.length >= 4) {
    return {
      citation: trimmed[0]!,
      failureScenario: trimmed.slice(1, -2).join(' ').trim(),
      evidence: trimmed.at(-2)!,
      disposition: maybeDisposition,
    };
  }

  return {
    citation: trimmed[0]!,
    failureScenario: trimmed.slice(1, -1).join(' ').trim(),
    evidence: lastLine,
  };
}

function parseFindingBlock(severity: string, lines: string[]): PlanReviewFinding {
  const text = lines
    .map((line) => line.trim())
    .join(' ')
    .trim();
  if (text.length === 0) {
    wrapParseError('findings section entries must not be empty');
  }

  const parsedFields = text.includes('|')
    ? splitDelimitedFindingBody(text)
    : splitUnDelimitedFindingBody(lines);
  const disposition =
    parsedFields.disposition === undefined
      ? undefined
      : parseDispositionToken(parsedFields.disposition);

  const findingBase = {
    severity: parseSeverityToken(severity),
    citation: parsedFields.citation
      .trim()
      .replace(/(^`|`$)/g, '')
      .trim(),
    failureScenario: parsedFields.failureScenario.trim(),
    evidence: parseEvidenceToken(parsedFields.evidence),
  };
  try {
    if (disposition === undefined) {
      return planReviewFindingSchema.parse(findingBase) as PlanReviewFinding;
    }
    return planReviewFindingSchema.parse({ ...findingBase, disposition }) as PlanReviewFinding;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    wrapParseError(`invalid plan-review finding entry: ${message}`);
  }
}

function collectBulletBlocks(lines: string[], sectionName: string): string[][] {
  const items: string[][] = [];
  let current: string[] | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0) {
      continue;
    }

    const bulletMatch = BULLET_LINE_RE.exec(line.trimStart());
    if (bulletMatch) {
      if (current !== undefined) {
        items.push(current);
      }
      current = [bulletMatch[1]!.trim()];
      continue;
    }

    if (current === undefined) {
      wrapParseError(`${sectionName} section must use bullet items`);
    }

    current.push(line.trim());
  }

  if (current !== undefined) {
    items.push(current);
  }

  return items;
}

function parseVerdict(lines: string[]): PlanReviewFindingsDocument['verdict'] {
  const text = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  if (text.length === 0) {
    throw new PlanReviewFindingsParseError('verdict section is empty');
  }
  return parseVerdictToken(text);
}

function parseKnownLimitations(lines: string[]): string[] {
  return collectBulletBlocks(lines, 'known_limitations').map((block) => block.join(' ').trim());
}

function parseFindings(lines: string[]): PlanReviewFinding[] {
  const findings: PlanReviewFinding[] = [];
  const blocks = collectFindingBlocks(lines);

  for (const block of blocks) {
    findings.push(parseFindingBlock(block.severity, block.lines));
  }

  return findings;
}

function collectFindingBlocks(lines: string[]): Array<{ severity: string; lines: string[] }> {
  const findings: Array<{ severity: string; lines: string[] }> = [];
  let current: { severity: string; lines: string[] } | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0) {
      continue;
    }

    const findingMatch = FINDING_LINE_RE.exec(line.trimStart());
    if (findingMatch) {
      if (current !== undefined) {
        findings.push(current);
      }
      current = { severity: findingMatch[1]!, lines: [findingMatch[2]!.trim()] };
      continue;
    }

    if (current === undefined) {
      throw new PlanReviewFindingsParseError('findings section must use bullet items');
    }

    current.lines.push(line.trim());
  }

  if (current !== undefined) {
    findings.push(current);
  }

  return findings;
}

function finalizeDocument(
  verdict: PlanReviewFindingsDocument['verdict'],
  findings: PlanReviewFinding[],
  parsedKnownLimitations: string[] | undefined,
): PlanReviewFindingsDocument {
  if (verdict === 'pass') {
    const unresolvedFindings = findings.filter(
      (f) => f.disposition === undefined || f.disposition === 'still_open',
    );
    if (unresolvedFindings.length > 0) {
      throw new PlanReviewFindingsParseError('pass verdict must not include unresolved findings');
    }
  }

  if (verdict !== 'pass' && findings.length === 0) {
    throw new PlanReviewFindingsParseError(`${verdict} verdict requires at least one finding`);
  }

  const documentResult = planReviewFindingsSchema.safeParse({
    verdict,
    ...(verdict === 'proceed_with_concerns' ? { knownLimitations: parsedKnownLimitations } : {}),
    findings,
  });
  if (!documentResult.success) {
    throw new PlanReviewFindingsParseError(
      `invalid plan-review findings document: ${documentResult.error.message}`,
    );
  }
  const document = documentResult.data;

  if (verdict === 'proceed_with_concerns') {
    const knownLimitations = document.knownLimitations;
    if (knownLimitations === undefined) {
      throw new PlanReviewFindingsParseError(
        'known_limitations section is required when verdict is proceed_with_concerns',
      );
    }
    if (knownLimitations.length === 0) {
      throw new PlanReviewFindingsParseError(
        'known_limitations section must include at least one bullet when verdict is proceed_with_concerns',
      );
    }
  }

  return document;
}

export function parsePlanReviewFindings(
  markdown: string,
  resolver?: EvidenceResolver,
): PlanReviewFindingsDocument | Promise<PlanReviewFindingsDocument> {
  if (typeof markdown !== 'string') {
    throw new PlanReviewFindingsParseError('plan-review findings markdown must be a string');
  }

  const lines = normalizeLines(markdown);
  const verdict = parseVerdict(extractSectionLines(lines, 'verdict'));
  const findings = parseFindings(extractSectionLines(lines, 'findings'));
  const knownLimitationsSection = maybeExtractSectionLines(lines, 'known_limitations');

  if (verdict !== 'proceed_with_concerns' && knownLimitationsSection !== undefined) {
    throw new PlanReviewFindingsParseError(
      'known_limitations section is only allowed when verdict is proceed_with_concerns',
    );
  }

  const parsedKnownLimitations =
    knownLimitationsSection === undefined
      ? undefined
      : parseKnownLimitations(knownLimitationsSection);

  if (resolver) {
    return (async () => {
      for (const f of findings) {
        if (!f.citation || !f.failureScenario) {
          f.evidence = 'ungrounded';
          continue;
        }
        try {
          const resolved = await resolver(f);
          f.evidence = resolved ? 'grounded' : 'ungrounded';
        } catch {
          f.evidence = 'ungrounded';
        }
      }
      return finalizeDocument(verdict, findings, parsedKnownLimitations);
    })();
  }

  return finalizeDocument(verdict, findings, parsedKnownLimitations);
}
