import { execa } from 'execa';
import type {
  GitHubPort,
  GitHubIssue,
  PullRequestDetail,
  PullRequest,
  PullRequestReview,
  GitHubReviewComment,
  CreatePullRequestInput,
} from '@ai-sdlc/application/ports';
import { GitHubFailedError } from './errors.js';

export interface GhCliAdapterOptions {
  ghPath?: string;
  maxRetries?: number;
  backoffMs?: number;
  env?: Record<string, string>;
}

interface RestComment {
  id: number;
  path: string;
  line: number | null;
  user: { login: string } | null | undefined;
  body: string;
  created_at: string;
  in_reply_to_id: number | null;
  pull_request_review_id?: number;
}

export class GhCliAdapter implements GitHubPort {
  private readonly gh: string;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly env: Record<string, string>;

  constructor(opts: GhCliAdapterOptions = {}) {
    this.gh = opts.ghPath ?? 'gh';
    this.maxRetries = opts.maxRetries ?? 2;
    this.backoffMs = opts.backoffMs ?? 1000;
    this.env = opts.env ?? {};
  }

  private safeJsonParse<T>(raw: string, command: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new GitHubFailedError(command, `Invalid JSON output: ${raw.slice(0, 200)}`);
    }
  }

  private async run(args: string[]): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const { stdout } = await execa(this.gh, args, {
          reject: true,
          env: { ...process.env, ...this.env },
        });
        return stdout;
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, this.backoffMs * (attempt + 1)));
        }
      }
    }
    const stderr =
      (lastErr as { stderr?: string })?.stderr ?? (lastErr as Error)?.message ?? 'unknown';
    throw new GitHubFailedError(`${this.gh} ${args.join(' ')}`, String(stderr));
  }

  async getIssue(repoFullName: string, issueNumber: number): Promise<GitHubIssue> {
    const out = await this.run([
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      repoFullName,
      '--json',
      'number,title,body,labels',
    ]);
    const command = `gh issue view ${issueNumber} --repo ${repoFullName}`;
    const j = this.safeJsonParse<{
      number: number;
      title: string;
      body: string;
      labels: Array<{ name: string }>;
    }>(out, command);
    return { number: j.number, title: j.title, body: j.body, labels: j.labels.map((l) => l.name) };
  }

  async getPr(repoFullName: string, prNumber: number): Promise<PullRequestDetail> {
    const out = await this.run([
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repoFullName,
      '--json',
      'number,url,state,headRefName',
    ]);
    const command = `gh pr view ${prNumber} --repo ${repoFullName}`;
    const j = this.safeJsonParse<{
      number: number;
      url: string;
      state: string;
      headRefName: string;
    }>(out, command);
    const VALID_STATES = new Set(['open', 'closed', 'merged']);
    const normalised = j.state.toLowerCase();
    if (!VALID_STATES.has(normalised)) {
      throw new GitHubFailedError(
        `gh pr view ${prNumber} --repo ${repoFullName}`,
        `Unexpected PR state: ${j.state}`,
      );
    }
    return {
      number: j.number,
      url: j.url,
      state: normalised as PullRequest['state'],
      headRefName: j.headRefName,
    };
  }

  async listReviewComments(repoFullName: string, prNumber: number): Promise<GitHubReviewComment[]> {
    const out = await this.run([
      'api',
      '--paginate',
      '--slurp',
      `repos/${repoFullName}/pulls/${prNumber}/comments`,
    ]);
    return this.parseComments(out, prNumber);
  }

  async listReviews(repoFullName: string, prNumber: number): Promise<PullRequestReview[]> {
    const out = await this.run(['api', `repos/${repoFullName}/pulls/${prNumber}/reviews`]);
    const command = `gh api repos/${repoFullName}/pulls/${prNumber}/reviews`;
    const reviews = this.safeJsonParse<
      Array<{ id: number; state: string; user: { login: string } | null }>
    >(out, command);
    const VALID_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENT', 'PENDING']);
    return reviews.map((r) => ({
      id: r.id,
      state: (VALID_STATES.has(r.state) ? r.state : 'COMMENT') as PullRequestReview['state'],
      user: r.user?.login ?? 'ghost',
    }));
  }

  async listPrCommentsSince(
    repoFullName: string,
    prNumber: number,
    sinceIso: string,
  ): Promise<GitHubReviewComment[]> {
    const all = await this.listReviewComments(repoFullName, prNumber);
    const since = new Date(sinceIso);
    if (isNaN(since.getTime())) {
      throw new GitHubFailedError(
        `listPrCommentsSince(${repoFullName}, ${prNumber})`,
        `Invalid ISO date string: ${sinceIso}`,
      );
    }
    return all.filter((c) => c.createdAt >= since);
  }

  private parseComments(raw: string, prNumber: number): GitHubReviewComment[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const command = `gh api --paginate --slurp repos/.../pulls/${prNumber}/comments`;
    const parsed = this.safeJsonParse<RestComment[][]>(trimmed, command);
    const flat = parsed.flat();
    return flat.map((c) => ({
      id: c.id,
      prNumber,
      path: c.path,
      line: c.line ?? 0,
      reviewer: c.user?.login ?? 'ghost',
      body: c.body,
      createdAt: new Date(c.created_at),
      ...(c.in_reply_to_id !== null ? { inReplyToId: c.in_reply_to_id } : {}),
      ...(c.pull_request_review_id !== undefined ? { reviewId: c.pull_request_review_id } : {}),
    }));
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    const args = [
      'pr',
      'create',
      '--repo',
      input.repoFullName,
      '--base',
      input.baseBranch,
      '--head',
      input.headBranch,
      '--title',
      input.title,
      '--body',
      input.body,
    ];
    if (input.draft) args.push('--draft');
    const out = await this.run(args);
    const url = out.trim().split('\n').pop() ?? '';
    const numMatch = url.match(/\/pull\/(\d+)/);
    if (!numMatch) {
      throw new GitHubFailedError(
        `gh pr create --repo ${input.repoFullName}`,
        `Could not parse PR number from output: ${url}`,
      );
    }
    return { number: Number(numMatch[1]), url, state: 'open' };
  }

  async replyToReviewComment(
    repoFullName: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<void> {
    await this.run([
      'api',
      `repos/${repoFullName}/pulls/${prNumber}/comments/${commentId}/replies`,
      '--method',
      'POST',
      '--raw-field',
      `body=${body}`,
    ]);
  }

  async resolveReviewThread(
    repoFullName: string,
    prNumber: number,
    commentId: number,
  ): Promise<void> {
    const [owner, repo] = repoFullName.split('/');
    const threadPageSize = 100;
    const commentPageSize = 50;
    let threadCursor: string | null = null;

    while (true) {
      const cursorParam = threadCursor ? `,$afterThread:String!` : '';
      const cursorArg = threadCursor ? `,after:$afterThread` : '';
      const query = `query($owner:String!,$repo:String!,$pr:Int!${cursorParam}){repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:${threadPageSize}${cursorArg}){nodes{id isResolved comments(first:${commentPageSize}){nodes{databaseId}}}pageInfo{hasNextPage endCursor}}}}}`;
      const ghArgs = [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-F',
        `owner=${owner}`,
        '-F',
        `repo=${repo}`,
        '-F',
        `pr=${prNumber}`,
      ];
      if (threadCursor) {
        ghArgs.push('-F', `afterThread=${threadCursor}`);
      }
      const out = await this.run(ghArgs);
      const command = `gh api graphql owner=${owner} repo=${repo} pr=${prNumber}`;
      const data = this.safeJsonParse<{
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: Array<{
                  id: string;
                  isResolved: boolean;
                  comments: { nodes: Array<{ databaseId: number }> };
                }>;
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
              };
            };
          };
        };
      }>(out, command);

      const threads = data.data.repository.pullRequest.reviewThreads.nodes;
      const thread = threads.find(
        (t) => !t.isResolved && t.comments.nodes.some((c) => c.databaseId === commentId),
      );
      if (thread) {
        const mutation = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`;
        await this.run(['api', 'graphql', '-f', `query=${mutation}`, '-F', `id=${thread.id}`]);
        return;
      }

      const pageInfo = data.data.repository.pullRequest.reviewThreads.pageInfo;
      if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
      threadCursor = pageInfo.endCursor;
    }
  }

  async updateIssueLabels(
    repoFullName: string,
    issueNumber: number,
    labels: { add?: string[]; remove?: string[] },
  ): Promise<void> {
    const args = ['issue', 'edit', String(issueNumber), '--repo', repoFullName];
    for (const l of labels.add ?? []) args.push('--add-label', l);
    for (const l of labels.remove ?? []) args.push('--remove-label', l);
    if (args.length <= 5) return;
    await this.run(args);
  }
}
