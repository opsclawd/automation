import { GitPort } from '../ports/git-port.js';
import { PrReviewComment } from '@ai-sdlc/domain';

export interface ContextSelectorInput {
  cwd: string;
  comments: PrReviewComment[];
  attempt: number;
  diff: string; // current full diff origin/HEAD..HEAD (or similar)
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

export class DefaultContextSelector implements ContextSelectorPort {
  constructor(private readonly git: GitPort) {}

  async select(input: ContextSelectorInput): Promise<SelectedContext> {
    const { attempt, diff, comments, cwd, previousBuildError, previousCodeVerifyReason } = input;

    const diffStats = await this.git.diffStat(cwd, 'origin/HEAD');

    if (attempt === 3) {
      return {
        comments: comments.map((c) => ({
          commentId: c.commentId,
          path: c.path,
          line: c.line,
          body: c.body,
          context: 'Full PR diff included as requested for Attempt 3.',
        })),
        files: [],
        diffs: [{ content: diff }],
        diffStats,
        additionalInfo: undefined,
      };
    }

    let additionalInfo: string | undefined = undefined;
    if (attempt === 2) {
      let info = '';
      if (previousBuildError) info += `### Previous Build Error\n\n${previousBuildError}\n\n`;
      if (previousCodeVerifyReason)
        info += `### Previous Code Verification Rejection\n\n> ${previousCodeVerifyReason}\n\n`;
      if (info) additionalInfo = info;
    }

    return {
      comments: comments.map((c) => ({
        commentId: c.commentId,
        path: c.path,
        line: c.line,
        body: c.body,
        context:
          attempt === 1
            ? 'Attempt 1: Limited context (implemented via full diff for now).'
            : 'Attempt 2: Expanded context (full file diffs).',
      })),
      files: [],
      diffs: [{ content: diff }],
      diffStats,
      additionalInfo,
    };
  }
}
