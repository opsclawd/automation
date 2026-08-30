import type { GitHubPort } from '../ports/github-port.js';

export type ArchitectureRequirementCategory =
  | 'acceptance_criteria'
  | 'goal'
  | 'anchored_design'
  | 'trap_non_goal'
  | 'comment'
  | 'consumer_requirement'
  | 'general';

export interface ArchitectureRequirementItem {
  id: string;
  category: ArchitectureRequirementCategory;
  title: string;
  source: string;
  description?: string | undefined;
}

export interface ArchitectureRequirementsLedger {
  version: 1;
  issueNumber: number;
  items: ArchitectureRequirementItem[];
}

export interface BuildArchitectureRequirementsOptions {
  issueNumber: number;
  repoFullName?: string | undefined;
  issueMd: string;
  issueCommentsMd?: string | undefined;
  github?: GitHubPort | undefined;
}

function extractAcceptanceCriteria(markdown: string): string[] {
  const criteria: string[] = [];
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*[-*]\s*\[([ xX])\]\s*(.+)$/.exec(line);
    if (match && match[2]) {
      const text = match[2].trim();
      if (text.length > 0) {
        criteria.push(text);
      }
    }
  }
  return criteria;
}

function extractSections(markdown: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  const lines = markdown.split(/\r?\n/);
  let currentHeader: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    // Only split top-level sections on # or ## (H1 and H2), allowing H3/H4 inside sections
    const headerMatch = /^#{1,2}\s+(.+)$/.exec(line);
    if (headerMatch && headerMatch[1]) {
      if (currentHeader) {
        sections.set(currentHeader.toLowerCase().trim(), currentLines);
      }
      currentHeader = headerMatch[1].trim();
      currentLines = [];
    } else if (currentHeader) {
      currentLines.push(line);
    }
  }

  if (currentHeader) {
    sections.set(currentHeader.toLowerCase().trim(), currentLines);
  }

  return sections;
}

function extractBulletsOrParagraphs(lines: string[]): string[] {
  const items: string[] = [];
  let currentParagraph = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentParagraph) {
        items.push(currentParagraph);
        currentParagraph = '';
      }
      continue;
    }

    // Skip Markdown comments or section headers if passed directly
    if (/^#{1,2}\s+/.test(trimmed)) {
      if (currentParagraph) {
        items.push(currentParagraph);
        currentParagraph = '';
      }
      continue;
    }

    const bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    const numMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
    const subHeaderMatch = /^#{3,4}\s+(.+)$/.exec(trimmed);

    if (bulletMatch && bulletMatch[1]) {
      if (currentParagraph) {
        items.push(currentParagraph);
        currentParagraph = '';
      }
      items.push(bulletMatch[1].trim());
    } else if (numMatch && numMatch[1]) {
      if (currentParagraph) {
        items.push(currentParagraph);
        currentParagraph = '';
      }
      items.push(numMatch[1].trim());
    } else if (subHeaderMatch && subHeaderMatch[1]) {
      if (currentParagraph) {
        items.push(currentParagraph);
        currentParagraph = '';
      }
      items.push(subHeaderMatch[1].trim());
    } else {
      if (currentParagraph) {
        currentParagraph += ' ' + trimmed;
      } else {
        currentParagraph = trimmed;
      }
    }
  }

  if (currentParagraph) {
    items.push(currentParagraph);
  }

  return items;
}

function findCandidateIssueNumbers(text: string, currentIssue: number): number[] {
  const candidates = new Set<number>();
  const generalRegex = /(?:#|issues\/)(\d+)/gi;
  for (const m of text.matchAll(generalRegex)) {
    if (m[1]) {
      const num = parseInt(m[1], 10);
      if (!isNaN(num) && num > 0 && num !== currentIssue) {
        candidates.add(num);
      }
    }
  }
  return Array.from(candidates).slice(0, 20);
}

export function isDirectConsumerRelationship(
  candidateNumber: number,
  candidateBody: string,
  candidateTitle: string,
  currentIssue: number,
  currentIssueText: string,
): boolean {
  // 1. Candidate issue declares dependency on current issue
  const candidateText = `${candidateTitle}\n${candidateBody}`;
  const candidateDepRegex = new RegExp(
    `(?:depends on|depended on by|requires|required by|direct consumer|downstream|unblocks|blocked by|parent issue|following)\\s*[:#\\s]*#?${currentIssue}\\b`,
    'i',
  );
  if (candidateDepRegex.test(candidateText)) {
    return true;
  }

  // 2. Current issue explicitly declares candidate issue as direct consumer / dependent
  const currentDepRegex = new RegExp(
    `(?:direct consumer|consumer|depended on by|required by|downstream|unblocks|depends on)\\s*[:#\\s]*#?${candidateNumber}\\b`,
    'i',
  );
  if (currentDepRegex.test(currentIssueText)) {
    // Make sure it's not marked as upstream/historical in current issue
    const historicalRegex = new RegExp(
      `(?:fixes|closed by|closes|resolves|resolved by|supercedes|precursor|prior art)\\s*[:#\\s]*#?${candidateNumber}\\b`,
      'i',
    );
    if (!historicalRegex.test(currentIssueText)) {
      return true;
    }
  }

  return false;
}

export async function buildArchitectureRequirementsLedger(
  opts: BuildArchitectureRequirementsOptions,
): Promise<ArchitectureRequirementsLedger> {
  const items: ArchitectureRequirementItem[] = [];
  const seenTitles = new Set<string>();

  const addItem = (item: ArchitectureRequirementItem) => {
    const key = `${item.category}:${item.title.toLowerCase().trim()}`;
    if (!seenTitles.has(key)) {
      seenTitles.add(key);
      items.push(item);
    }
  };

  // 1. Acceptance Criteria from issue body
  const acList = extractAcceptanceCriteria(opts.issueMd);
  for (let i = 0; i < acList.length; i++) {
    addItem({
      id: `AC-${i + 1}`,
      category: 'acceptance_criteria',
      title: acList[i]!,
      source: 'issue.md',
    });
  }

  // 2. Anchored sections from issue body
  const sections = extractSections(opts.issueMd);
  let goalIdx = 1;
  let designIdx = 1;
  let trapIdx = 1;

  for (const [header, secLines] of sections.entries()) {
    if (
      header.includes('non-goals') ||
      header.includes('non goals') ||
      header.includes('nongoals') ||
      header.includes('traps')
    ) {
      const extracted = extractBulletsOrParagraphs(secLines);
      for (const entry of extracted) {
        addItem({
          id: `REQ-TRAP-${trapIdx++}`,
          category: 'trap_non_goal',
          title: entry,
          source: 'issue.md',
        });
      }
    } else if (header.includes('acceptance criteria') || header.includes('acceptance criterion')) {
      // Already extracted checkbox criteria, but if no checkboxes found, extract bullets
      if (acList.length === 0) {
        const bullets = extractBulletsOrParagraphs(secLines);
        for (const bullet of bullets) {
          addItem({
            id: `AC-${items.filter((it) => it.category === 'acceptance_criteria').length + 1}`,
            category: 'acceptance_criteria',
            title: bullet,
            source: 'issue.md',
          });
        }
      }
    } else if (
      header === 'goal' ||
      header.startsWith('goal') ||
      header.includes('goals') ||
      header.includes('goal')
    ) {
      const extracted = extractBulletsOrParagraphs(secLines);
      for (const entry of extracted) {
        addItem({
          id: `REQ-GOAL-${goalIdx++}`,
          category: 'goal',
          title: entry,
          source: 'issue.md',
        });
      }
    } else if (
      header.includes('anchored design') ||
      header.includes('required changes') ||
      header.includes('design')
    ) {
      const extracted = extractBulletsOrParagraphs(secLines);
      for (const entry of extracted) {
        addItem({
          id: `REQ-DESIGN-${designIdx++}`,
          category: 'anchored_design',
          title: entry,
          source: 'issue.md',
        });
      }
    }
  }

  // 3. Issue comments requirements
  if (opts.issueCommentsMd && opts.issueCommentsMd.trim().length > 0) {
    const commentBullets = extractBulletsOrParagraphs(opts.issueCommentsMd.split(/\r?\n/));
    let commentIdx = 1;
    for (const commentItem of commentBullets) {
      if (commentItem.length > 10) {
        addItem({
          id: `COMMENT-${commentIdx++}`,
          category: 'comment',
          title: commentItem,
          source: 'issue-comments.md',
        });
      }
    }
  }

  // 4. Two-Stage Relationship-Validated Direct Consumer Discovery
  const currentIssueFullText = `${opts.issueMd}\n${opts.issueCommentsMd ?? ''}`;
  const candidateNumbers = new Set<number>(
    findCandidateIssueNumbers(currentIssueFullText, opts.issueNumber),
  );

  if (opts.github && opts.repoFullName) {
    if (typeof opts.github.searchIssues === 'function') {
      try {
        const searchResults = await opts.github.searchIssues(
          opts.repoFullName,
          `#${opts.issueNumber}`,
        );
        for (const dep of searchResults) {
          if (dep.number !== opts.issueNumber) {
            candidateNumbers.add(dep.number);
          }
        }
      } catch (err) {
        throw new Error(
          `Failed to search direct consumer issues for #${opts.issueNumber}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Stage 2: Validate each candidate's relationship before adding as direct consumer
    const validatedConsumers: Array<{ number: number; title: string; body: string }> = [];
    for (const candNum of Array.from(candidateNumbers).slice(0, 10)) {
      let candidateIssue: { number: number; title: string; body: string };
      try {
        candidateIssue = await opts.github.getIssue(opts.repoFullName, candNum);
      } catch (err) {
        throw new Error(
          `Failed to fetch candidate consumer issue #${candNum}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      if (
        candidateIssue &&
        candidateIssue.body &&
        isDirectConsumerRelationship(
          candNum,
          candidateIssue.body,
          candidateIssue.title,
          opts.issueNumber,
          currentIssueFullText,
        )
      ) {
        validatedConsumers.push(candidateIssue);
      }
    }

    // Extract requirements from validated direct consumers
    for (const directConsumer of validatedConsumers) {
      const refNum = directConsumer.number;
      let consumerItemCount = 0;

      // a) Acceptance criteria from consumer
      const consumerAcs = extractAcceptanceCriteria(directConsumer.body);
      for (let i = 0; i < consumerAcs.length; i++) {
        addItem({
          id: `CONSUMER-${refNum}-AC-${i + 1}`,
          category: 'consumer_requirement',
          title: consumerAcs[i]!,
          source: `issue #${refNum}`,
          description: `Direct consumer requirement from #${refNum} (${directConsumer.title})`,
        });
        consumerItemCount++;
      }

      // b) Goal / Anchored Design / Required changes from consumer
      const consumerSections = extractSections(directConsumer.body);
      let consumerGoalIdx = 1;
      let consumerDesignIdx = 1;

      for (const [cHeader, cSecLines] of consumerSections.entries()) {
        if (cHeader === 'goal' || cHeader.startsWith('goal') || cHeader.includes('goals')) {
          const bullets = extractBulletsOrParagraphs(cSecLines);
          for (const bullet of bullets) {
            addItem({
              id: `CONSUMER-${refNum}-GOAL-${consumerGoalIdx++}`,
              category: 'consumer_requirement',
              title: bullet,
              source: `issue #${refNum}`,
              description: `Direct consumer goal from #${refNum} (${directConsumer.title})`,
            });
            consumerItemCount++;
          }
        } else if (
          cHeader.includes('anchored design') ||
          cHeader.includes('required changes') ||
          cHeader.includes('design') ||
          cHeader.includes('architecture')
        ) {
          const bullets = extractBulletsOrParagraphs(cSecLines);
          for (const bullet of bullets) {
            addItem({
              id: `CONSUMER-${refNum}-DESIGN-${consumerDesignIdx++}`,
              category: 'consumer_requirement',
              title: bullet,
              source: `issue #${refNum}`,
              description: `Direct consumer design requirement from #${refNum} (${directConsumer.title})`,
            });
            consumerItemCount++;
          }
        }
      }

      // c) Fallback if consumer body had no structured sections/ACs
      if (consumerItemCount === 0) {
        addItem({
          id: `CONSUMER-${refNum}-REQ-1`,
          category: 'consumer_requirement',
          title: directConsumer.title || `Consumer issue #${refNum} contract requirements`,
          source: `issue #${refNum}`,
          description: `Direct consumer requirement from #${refNum}`,
        });
      }
    }
  }

  // 5. Fallback if no specific requirements extracted
  if (items.length === 0) {
    const fallbackTitle = opts.issueMd
      .trim()
      .split('\n')[0]
      ?.replace(/^#+\s*/, '')
      .trim();
    items.push({
      id: 'REQ-1',
      category: 'general',
      title:
        fallbackTitle && fallbackTitle.length > 0
          ? fallbackTitle
          : `Issue #${opts.issueNumber} requirements`,
      source: 'issue.md',
    });
  }

  return {
    version: 1,
    issueNumber: opts.issueNumber,
    items,
  };
}

export function formatRequirementsLedgerForPrompt(ledger: ArchitectureRequirementsLedger): string {
  if (ledger.items.length === 0) {
    return 'No requirements recorded in ledger.';
  }

  const lines: string[] = [
    `# Architecture Requirements Ledger (Issue #${ledger.issueNumber})`,
    '',
    'You MUST disposition EVERY item below in `requirements_checks` by specifying its exact `requirement_id`.',
    'Approval is impossible if any item is omitted, failed, or unresolved.',
    '',
  ];

  for (const item of ledger.items) {
    lines.push(`- **[${item.id}] [${item.category.toUpperCase()}]** (${item.source})`);
    lines.push(`  ${item.title}`);
    if (item.description) {
      lines.push(`  *Context:* ${item.description}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
