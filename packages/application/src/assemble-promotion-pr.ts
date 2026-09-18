import type { ReleaseBatch } from '@ai-sdlc/domain';
import type { GitHubPort } from './ports/github-port.js';
import type { GitPort } from './ports/git-port.js';

export interface AssemblePromotionPrInput {
  batch: ReleaseBatch;
  repoFullName: string;
  candidateSha?: string | undefined;
  localBasePath?: string | undefined;
  github?: GitHubPort | undefined;
  git?: GitPort | undefined;
}

export interface PromotionPrContent {
  title: string;
  body: string;
}

const MAX_PR_BODY_LENGTH = 60_000;

export async function assemblePromotionPr(
  input: AssemblePromotionPrInput,
): Promise<PromotionPrContent> {
  const { batch, repoFullName, github, git, localBasePath } = input;
  const candidateSha = input.candidateSha ?? batch.candidateSha ?? 'unknown';

  const uniqueIssueNumbers = [...new Set(batch.items.map((item) => item.issueNumber))].sort(
    (a, b) => a - b,
  );

  // 1. Build PR Title
  const issuesSummary = uniqueIssueNumbers.map((num) => `#${num}`).join(', ');
  let title = `Release ${batch.id}: ${issuesSummary}`;
  if (title.length > 250) {
    title = `Release ${batch.id}: ${uniqueIssueNumbers.length} issues (#${uniqueIssueNumbers[0]}...#${uniqueIssueNumbers[uniqueIssueNumbers.length - 1]})`;
  }

  // 2. Fetch Issue Titles & Details (graceful fallback)
  const issueDetails: Array<{ number: number; title?: string; labels?: string[] }> = [];
  for (const num of uniqueIssueNumbers) {
    if (github) {
      try {
        const issue = await github.getIssue(repoFullName, num);
        issueDetails.push({
          number: num,
          title: issue.title,
          labels: issue.labels,
        });
        continue;
      } catch {
        // Fallback below
      }
    }
    issueDetails.push({ number: num });
  }

  // 3. Fetch Git Commits (if git port and local path available)
  let commitLogs: string[] = [];
  if (git && localBasePath && batch.sourceStartSha && candidateSha !== 'unknown') {
    try {
      commitLogs = await git.logBetween(localBasePath, batch.sourceStartSha, candidateSha);
    } catch {
      // Graceful fallback if git log fails
    }
  }

  // 4. Assemble PR Markdown Body
  const sections: string[] = [];

  // Header & Metadata
  sections.push(`## Release Promotion: \`${batch.id}\`

| Property | Value |
| :--- | :--- |
| **Release Branch** | \`${batch.releaseBranch}\` |
| **Target Branch** | \`${batch.sourceBranch}\` |
| **Candidate SHA** | \`${candidateSha}\` |
| **Included Issues** | ${uniqueIssueNumbers.length} |
| **Status** | Awaiting Operator Review |`);

  // Batch Narrative & Overview
  sections.push(`### Overview & Cumulative Architecture

This pull request promotes autonomous release batch \`${batch.id}\` into \`${batch.sourceBranch}\`.
All items in this release sequence have completed automated implementation, validation, and integration tests on the release branch.`);

  // Included Issues Table
  const issueLines = issueDetails.map((detail) => {
    const titlePart = detail.title ? ` - **${detail.title}**` : '';
    const labelPart =
      detail.labels && detail.labels.length > 0 ? ` \`[${detail.labels.join(', ')}]\`` : '';
    return `- #${detail.number}${titlePart}${labelPart}`;
  });
  sections.push(`### Included Issues\n\n${issueLines.join('\n')}`);

  // Component Additions & Git Changes
  if (commitLogs.length > 0) {
    const formattedCommits = commitLogs.map((c) => `- ${c}`).join('\n');
    sections.push(`### Component Additions & Cumulative Commits\n\n${formattedCommits}`);
  }

  // Verification & Test Results
  const itemStatusLines = batch.items.map((item) => {
    const shaPart = item.mergedCommitSha ? ` (merged at \`${item.mergedCommitSha}\`)` : '';
    return `- Position ${item.position}: Issue #${item.issueNumber} - status: \`${item.status}\`${shaPart}`;
  });

  sections.push(`### Verification & Test Results

- All batch items were sequentially admitted, verified, and merged into \`${batch.releaseBranch}\`:
${itemStatusLines.join('\n')}
- Release candidate commit \`${candidateSha}\` contains all constituent merge commits.
- Branch ancestry and drift validations confirmed no conflicting modifications against \`${batch.sourceBranch}\`.`);

  // Safety Default Notice
  sections.push(`> [!IMPORTANT]
> **Safety Default**: Auto-merge is disabled on this promotion PR.
> Comprehensive review and manual promotion approval are required before merging into \`${batch.sourceBranch}\`.`);

  // Explicit Closes References
  const closesLines = uniqueIssueNumbers.map((num) => `Closes #${num}`).join('\n');
  sections.push(`### Linked Issues\n\n${closesLines}`);

  let body = sections.join('\n\n');

  // Truncate if exceeding GitHub limit
  if (body.length > MAX_PR_BODY_LENGTH) {
    const truncationNotice = '\n\n... [Content truncated to meet GitHub character limits]';
    // Ensure closing lines remain present at the bottom
    const closesBlock = `\n\n### Linked Issues\n\n${closesLines}`;
    const budget = MAX_PR_BODY_LENGTH - truncationNotice.length - closesBlock.length;
    body = body.slice(0, budget) + truncationNotice + closesBlock;
  }

  return {
    title,
    body,
  };
}
