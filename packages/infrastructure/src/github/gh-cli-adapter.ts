import { execa } from 'execa';
import type {
  GitHubPort,
  GitHubIssue,
  GitHubIssueComment,
  PullRequestDetail,
  PullRequest,
  PullRequestReview,
  GitHubReviewComment,
  CreatePullRequestInput,
  PrMergeReadiness,
  MergeMethod,
  RequestAutoMergeResult,
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

interface RestIssueComment {
  id: number;
  user: { login: string } | null | undefined;
  body: string;
  created_at: string;
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

  async listIssueComments(
    repoFullName: string,
    issueNumber: number,
  ): Promise<GitHubIssueComment[]> {
    const out = await this.run([
      'api',
      '--paginate',
      '--slurp',
      `repos/${repoFullName}/issues/${issueNumber}/comments`,
    ]);
    return this.parseIssueComments(out, repoFullName, issueNumber);
  }

  private parseIssueComments(
    raw: string,
    repoFullName: string,
    issueNumber: number,
  ): GitHubIssueComment[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const command = `gh api --paginate --slurp repos/${repoFullName}/issues/${issueNumber}/comments`;
    const parsed = this.safeJsonParse<RestIssueComment[][]>(trimmed, command);
    const flat = parsed.flat();
    return flat.map((c) => ({
      id: c.id,
      author: c.user?.login ?? 'ghost',
      body: c.body,
      createdAt: new Date(c.created_at),
    }));
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

  async getPrMergeReadiness(repoFullName: string, prNumber: number): Promise<PrMergeReadiness> {
    const out = await this.run([
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repoFullName,
      '--json',
      'number,state,statusCheckRollup,mergeStateStatus,autoMergeRequest',
    ]);
    const command = `gh pr view ${prNumber} --repo ${repoFullName}`;
    const j = this.safeJsonParse<{
      number: number;
      state: string;
      statusCheckRollup?: Array<{
        state?: string;
        status?: string;
        conclusion?: string;
        name?: string;
      }>;
      mergeStateStatus?: string;
      autoMergeRequest?: { enabledAt?: string } | null;
    }>(out, command);

    const normalisedState = j.state.toLowerCase() as 'open' | 'closed' | 'merged';
    const isMerged = normalisedState === 'merged';

    let ciStatus: 'passed' | 'failed' | 'pending' = 'passed';
    let failedDetail: string | undefined;

    if (j.statusCheckRollup && j.statusCheckRollup.length > 0) {
      const failedChecks: string[] = [];
      let hasPending = false;
      for (const check of j.statusCheckRollup) {
        const conclusion = (check.conclusion || check.state || check.status || '').toUpperCase();
        if (
          conclusion === 'FAILURE' ||
          conclusion === 'TIMED_OUT' ||
          conclusion === 'ACTION_REQUIRED' ||
          conclusion === 'CANCELLED' ||
          conclusion === 'ERROR'
        ) {
          failedChecks.push(check.name || 'check');
        } else if (
          conclusion === 'PENDING' ||
          conclusion === 'IN_PROGRESS' ||
          conclusion === 'QUEUED' ||
          conclusion === 'WAITING' ||
          conclusion === 'EXPECTED'
        ) {
          hasPending = true;
        }
      }

      if (failedChecks.length > 0) {
        ciStatus = 'failed';
        failedDetail = `Failed checks: ${failedChecks.join(', ')}`;
      } else if (hasPending) {
        ciStatus = 'pending';
      }
    }

    const rawMergeState = j.mergeStateStatus?.toLowerCase();
    const VALID_MERGE_STATES = new Set([
      'clean',
      'blocked',
      'dirty',
      'behind',
      'unstable',
      'unknown',
    ]);
    const mergeState: PrMergeReadiness['mergeStateStatus'] =
      rawMergeState && VALID_MERGE_STATES.has(rawMergeState)
        ? (rawMergeState as 'clean' | 'blocked' | 'dirty' | 'behind' | 'unstable' | 'unknown')
        : 'unknown';

    return {
      prNumber: j.number,
      state: normalisedState,
      isMerged,
      ciStatus,
      mergeStateStatus: mergeState,
      autoMergeEnabled: Boolean(j.autoMergeRequest),
      ...(failedDetail !== undefined ? { details: failedDetail } : {}),
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
      line: c.line ?? null,
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

  async requestAutoMerge(
    repoFullName: string,
    prNumber: number,
    mergeMethod: MergeMethod,
  ): Promise<RequestAutoMergeResult> {
    const methodFlag =
      mergeMethod === 'squash' ? '--squash' : mergeMethod === 'rebase' ? '--rebase' : '--merge';
    try {
      await this.run([
        'pr',
        'merge',
        String(prNumber),
        '--repo',
        repoFullName,
        '--auto',
        methodFlag,
      ]);
      return { requested: true };
    } catch (err) {
      const reason = err instanceof GitHubFailedError ? err.stderr : String(err);
      return { requested: false, reason };
    }
  }

  async replyToReviewComment(
    repoFullName: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<GitHubReviewComment> {
    const endpoint = `repos/${repoFullName}/pulls/${prNumber}/comments/${commentId}/replies`;
    const out = await this.run([
      'api',
      endpoint,
      '--method',
      'POST',
      '--raw-field',
      `body=${body}`,
    ]);
    const command = `gh api ${endpoint} --method POST`;
    const parsed = this.safeJsonParse<RestComment>(out, command);
    return {
      id: parsed.id,
      prNumber,
      path: parsed.path,
      line: parsed.line ?? null,
      reviewer: parsed.user?.login ?? 'ghost',
      body: parsed.body,
      createdAt: new Date(parsed.created_at),
      ...(parsed.in_reply_to_id !== null && parsed.in_reply_to_id !== undefined
        ? { inReplyToId: parsed.in_reply_to_id }
        : {}),
      ...(parsed.pull_request_review_id !== undefined
        ? { reviewId: parsed.pull_request_review_id }
        : {}),
    };
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

  async searchIssues(repoFullName: string, query: string): Promise<GitHubIssue[]> {
    const out = await this.run([
      'issue',
      'list',
      '--repo',
      repoFullName,
      '--search',
      query,
      '--json',
      'number,title,body,labels',
      '--limit',
      '10',
    ]);
    const command = `gh issue list --repo ${repoFullName} --search "${query}"`;
    const list = this.safeJsonParse<
      Array<{
        number: number;
        title: string;
        body: string;
        labels: Array<{ name: string }>;
      }>
    >(out, command);
    return list.map((j) => ({
      number: j.number,
      title: j.title,
      body: j.body,
      labels: (j.labels ?? []).map((l) => l.name),
    }));
  }
}
