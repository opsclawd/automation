import { GitPort } from '../ports/git-port.js';
import { PrReviewComment } from '@ai-sdlc/domain';

export interface ContextSelectorInput {
  cwd: string;
  comments: PrReviewComment[];
  attempt: number;
  diff: string;
  previousBuildError: string | undefined;
  previousCodeVerifyReason: string | undefined;
}

export interface SelectedContext {
  comments: {
    commentId: number;
    path: string;
    line: number;
    body: string;
    context: string;
  }[];
  files: {
    path: string;
    content: string;
  }[];
  diffs: {
    path?: string;
    content: string;
  }[];
  diffStats: string;
  additionalInfo: string | undefined;
}

export interface ContextSelectorPort {
  select(input: ContextSelectorInput): Promise<SelectedContext>;
}

interface DiffHunk {
  file: string;
  header: string;
  content: string;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

function parseHunks(diff: string): DiffHunk[] {
  const lines = diff.split('\n');
  const hunks: DiffHunk[] = [];
  let currentFile = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const parts = line.split(' ');
      currentFile = parts[parts.length - 1]!.replace(/^b\//, '');
      i++;
      continue;
    }

    if (line.startsWith('@@ ')) {
      const header = line;
      const match = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match) {
        const oldStart = parseInt(match[1]!, 10);
        const oldCount = match[2] ? parseInt(match[2], 10) : 1;
        const newStart = parseInt(match[3]!, 10);
        const newCount = match[4] ? parseInt(match[4], 10) : 1;

        const hunkLines = [line];
        i++;
        while (i < lines.length && !lines[i]!.startsWith('@@') && !lines[i]!.startsWith('diff --git ')) {
          hunkLines.push(lines[i]!);
          i++;
        }

        hunks.push({
          file: currentFile,
          header,
          content: hunkLines.join('\n'),
          oldStart,
          oldEnd: oldStart + oldCount,
          newStart,
          newEnd: newStart + newCount,
        });
        continue;
      }
    }
    i++;
  }
  return hunks;
}

export class DefaultContextSelector implements ContextSelectorPort {
  constructor(private readonly git: GitPort) {}

  async select(input: ContextSelectorInput): Promise<SelectedContext> {
    const { attempt, diff, comments = [], cwd, previousBuildError, previousCodeVerifyReason } = input;

    const diffStats = await this.git.diffStat(cwd, 'origin/HEAD');
    const allHunks = parseHunks(diff);

    if (attempt >= 3) {
      return {
        comments: comments.map((c) => ({
          commentId: c.commentId,
          path: c.path,
          line: c.line,
          body: c.body,
          context: 'Full PR diff included (Attempt 3+).',
        })),
        files: [],
        diffs: [{ content: diff }],
        diffStats,
        additionalInfo: undefined,
      };
    }

    const selectedFilePaths = new Set(comments.map((c) => c.path));
    const selectedDiffs: { path?: string; content: string }[] = [];
    const commentContexts: SelectedContext['comments'] = [];

    if (attempt === 1) {
      // Tier 1: Hunk-local context
      const hunksByFile: Record<string, string[]> = {};

      for (const comment of comments) {
        const relevantHunks = allHunks.filter((h) => {
          if (h.file !== comment.path) return false;
          // Comment line is typically relative to the "old" side in PR comments if it's a review on a diff
          // but GitHub's line number for "new" side is also common.
          // We check both with a small buffer.
          const buffer = 5;
          const inOldRange = comment.line >= h.oldStart - buffer && comment.line <= h.oldEnd + buffer;
          const inNewRange = comment.line >= h.newStart - buffer && comment.line <= h.newEnd + buffer;
          return inOldRange || inNewRange;
        });

        if (relevantHunks.length > 0) {
          if (!hunksByFile[comment.path]) hunksByFile[comment.path] = [];
          for (const h of relevantHunks) {
            if (!hunksByFile[comment.path]!.includes(h.content)) {
              hunksByFile[comment.path]!.push(h.content);
            }
          }
          commentContexts.push({
            commentId: comment.commentId,
            path: comment.path,
            line: comment.line,
            body: comment.body,
            context: `Including ${relevantHunks.length} relevant hunk(s) for this comment.`,
          });
        } else {
          commentContexts.push({
            commentId: comment.commentId,
            path: comment.path,
            line: comment.line,
            body: comment.body,
            context: 'No direct diff hunks found matching this line number in the current PR diff.',
          });
        }
      }

      for (const path in hunksByFile) {
        selectedDiffs.push({
          path,
          content: hunksByFile[path]!.join('\n\n'),
        });
      }
    } else {
      // Tier 2: File-level context
      for (const path of selectedFilePaths) {
        const fileDiffLines: string[] = [];
        let inTargetFile = false;
        const lines = diff.split('\n');
        for (const line of lines) {
          if (line.startsWith('diff --git ')) {
            inTargetFile = line.endsWith(` b/${path}`) || line.includes(` b/${path} `);
          }
          if (inTargetFile) {
            fileDiffLines.push(line);
          }
        }
        if (fileDiffLines.length > 0) {
          selectedDiffs.push({
            path,
            content: fileDiffLines.join('\n'),
          });
        }
      }

      for (const comment of comments) {
        commentContexts.push({
          commentId: comment.commentId,
          path: comment.path,
          line: comment.line,
          body: comment.body,
          context: `Including full diff for ${comment.path}.`,
        });
      }
    }

    let additionalInfo: string | undefined = undefined;
    if (attempt >= 2) {
      let info = '';
      if (previousBuildError) info += `### Previous Build Error\n\n${previousBuildError}\n\n`;
      if (previousCodeVerifyReason)
        info += `### Previous Code Verification Rejection\n\n> ${previousCodeVerifyReason}\n\n`;
      if (info) additionalInfo = info;
    }

    return {
      comments: commentContexts,
      files: [],
      diffs: selectedDiffs.length > 0 ? selectedDiffs : [{ content: 'No relevant diff found.' }],
      diffStats,
      additionalInfo,
    };
  }
}
