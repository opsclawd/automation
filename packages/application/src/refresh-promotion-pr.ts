import type { ReleaseBatch } from '@ai-sdlc/domain';
import type { GitHubPort } from './ports/github-port.js';

export interface RefreshPromotionPrOptions {
  github: GitHubPort;
  repoFullName: string;
  prNumber: number;
  batch: ReleaseBatch;
  candidateSha?: string | undefined;
}

/**
 * Updates the mechanical, structurally-derivable fields of an existing promotion PR body:
 * 1. Approved / Candidate SHA in Markdown table, inline text, and verification section.
 * 2. Included Issues count in the Markdown table (if present).
 * 3. The `Closes #N` list (replacing `### Linked Issues` or existing `Closes #` lines).
 *
 * Does NOT regenerate, synthesize, or modify narrative descriptions or custom comments.
 */
export function refreshPromotionPrBody(
  existingBody: string,
  candidateSha: string,
  issueNumbers: number[],
): string {
  const uniqueIssueNumbers = [...new Set(issueNumbers)].sort((a, b) => a - b);
  const closesLines = uniqueIssueNumbers.map((num) => `Closes #${num}`).join('\n');

  const trimmed = existingBody.trim();
  if (!trimmed) {
    return closesLines
      ? `Autonomous release batch promotion.\nApproved Candidate SHA: \`${candidateSha}\`\n\n${closesLines}`
      : `Autonomous release batch promotion.\nApproved Candidate SHA: \`${candidateSha}\``;
  }

  let body = existingBody;
  let candidateShaUpdated = false;

  // 1. Update Candidate SHA in Markdown table row if present
  // e.g. | **Candidate SHA** | `abc1234` |
  const tableCandidateShaRegex = /(\|\s*\*\*Candidate SHA\*\*\s*\|\s*)(`[^`]+`|[^|\n]+)(\s*\|)/gi;
  if (tableCandidateShaRegex.test(body)) {
    body = body.replace(tableCandidateShaRegex, `$1\`${candidateSha}\`$3`);
    candidateShaUpdated = true;
  }

  // 2. Update Candidate SHA in free-standing text if present
  // e.g. Approved Candidate SHA: `abc1234` or Candidate SHA: abc1234
  const inlineCandidateShaRegex = /((?:Approved\s+)?Candidate SHA:\s*)(?:`[^`]+`|\S+)/gi;
  if (inlineCandidateShaRegex.test(body)) {
    body = body.replace(inlineCandidateShaRegex, `$1\`${candidateSha}\``);
    candidateShaUpdated = true;
  }

  // 3. Update Candidate SHA in commit verification sentence if present
  // e.g. - Release candidate commit `abc1234` contains all constituent merge commits.
  const commitVerificationRegex =
    /(- Release candidate commit )`[^`]+`(\s+contains all constituent merge commits\.)/gi;
  if (commitVerificationRegex.test(body)) {
    body = body.replace(commitVerificationRegex, `$1\`${candidateSha}\`$2`);
  }

  // If candidate SHA was not present anywhere in the body, append it
  if (!candidateShaUpdated) {
    body = `${body.trimEnd()}\n\nApproved Candidate SHA: \`${candidateSha}\``;
  }

  // 4. Update Included Issues count in Markdown table if present
  // e.g. | **Included Issues** | 2 |
  const tableIssueCountRegex = /(\|\s*\*\*Included Issues\*\*\s*\|\s*)(\d+)(\s*\|)/gi;
  if (tableIssueCountRegex.test(body)) {
    body = body.replace(tableIssueCountRegex, `$1${uniqueIssueNumbers.length}$3`);
  }

  // 5. Update Closes references
  if (closesLines) {
    const linkedIssuesRegex = /(### Linked Issues)([\s\S]*?)(?=(?:\n##[#]?\s|$))/i;
    if (linkedIssuesRegex.test(body)) {
      body = body.replace(linkedIssuesRegex, `$1\n\n${closesLines}\n`);
    } else {
      const hasClosesLines = /^\s*Closes #\d+\s*$/im.test(body);
      if (hasClosesLines) {
        const stripped = body
          .split('\n')
          .filter((line) => !/^\s*Closes #\d+\s*$/i.test(line))
          .join('\n')
          .trimEnd();
        body = `${stripped}\n\n${closesLines}`;
      } else {
        body = `${body.trimEnd()}\n\n### Linked Issues\n\n${closesLines}`;
      }
    }
  }

  return body.trimEnd();
}

/**
 * Refreshes an existing promotion PR's mechanical fields (candidate SHA, closes list, title).
 * Only performs an API call if changes are detected.
 */
export async function refreshPromotionPr(options: RefreshPromotionPrOptions): Promise<void> {
  const { github, repoFullName, prNumber, batch } = options;
  const candidateSha = options.candidateSha ?? batch.approvedCandidateSha ?? batch.candidateSha;
  if (!candidateSha) {
    return;
  }

  const existingPr = await github.getPr(repoFullName, prNumber);
  const uniqueIssueNumbers = [...new Set(batch.items.map((i) => i.issueNumber))].sort(
    (a, b) => a - b,
  );

  const existingBody = existingPr.body ?? '';
  const refreshedBody = refreshPromotionPrBody(existingBody, candidateSha, uniqueIssueNumbers);

  let refreshedTitle: string | undefined;
  const defaultTitlePrefix = `Release ${batch.id}:`;
  if (existingPr.title && existingPr.title.startsWith(defaultTitlePrefix)) {
    const issuesSummary = uniqueIssueNumbers.map((num) => `#${num}`).join(', ');
    let newTitle = `${defaultTitlePrefix} ${issuesSummary}`;
    if (newTitle.length > 250) {
      newTitle = `Release ${batch.id}: ${uniqueIssueNumbers.length} issues (#${uniqueIssueNumbers[0]}...#${uniqueIssueNumbers[uniqueIssueNumbers.length - 1]})`;
    }
    if (newTitle !== existingPr.title) {
      refreshedTitle = newTitle;
    }
  }

  const bodyChanged = refreshedBody !== existingBody;
  const titleChanged = refreshedTitle !== undefined && refreshedTitle !== existingPr.title;

  if (!bodyChanged && !titleChanged) {
    return;
  }

  if (github.updatePullRequest) {
    await github.updatePullRequest({
      repoFullName,
      prNumber,
      ...(titleChanged ? { title: refreshedTitle } : {}),
      ...(bodyChanged ? { body: refreshedBody } : {}),
    });
  }
}
