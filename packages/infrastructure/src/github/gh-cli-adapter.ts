import { execa } from 'execa';
import type {
  GitHubPort,
  GitHubIssue,
  PullRequestDetail,
  PullRequest,
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
  user: { login: string };
  body: string;
  created_at: string;
  in_reply_to_id: number | null;
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
    const j = JSON.parse(out) as {
      number: number;
      title: string;
      body: string;
      labels: Array<{ name: string }>;
    };
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
    const j = JSON.parse(out) as {
      number: number;
      url: string;
      state: string;
      headRefName: string;
    };
    return {
      number: j.number,
      url: j.url,
      state: j.state.toLowerCase() as PullRequest['state'],
      headRefName: j.headRefName,
    };
  }

  async listReviewComments(repoFullName: string, prNumber: number): Promise<GitHubReviewComment[]> {
    const out = await this.run([
      'api',
      '--paginate',
      `repos/${repoFullName}/pulls/${prNumber}/comments`,
    ]);
    return this.parseComments(out, prNumber);
  }

  async listPrCommentsSince(
    repoFullName: string,
    prNumber: number,
    sinceIso: string,
  ): Promise<GitHubReviewComment[]> {
    const all = await this.listReviewComments(repoFullName, prNumber);
    const since = new Date(sinceIso);
    return all.filter((c) => c.createdAt >= since);
  }

  private parseComments(raw: string, prNumber: number): GitHubReviewComment[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const arrays = trimmed.split(/\n(?=\[)/).map((chunk) => JSON.parse(chunk) as RestComment[]);
    const flat = arrays.flat();
    return flat.map((c) => ({
      id: c.id,
      prNumber,
      path: c.path,
      line: c.line ?? 0,
      reviewer: c.user.login,
      body: c.body,
      createdAt: new Date(c.created_at),
      ...(c.in_reply_to_id !== null ? { inReplyToId: c.in_reply_to_id } : {}),
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
    return { number: numMatch ? Number(numMatch[1]) : 0, url, state: 'open' };
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
    const query = `query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved comments(first:50){nodes{databaseId}}}}}}}`;
    const out = await this.run([
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
    ]);
    const data = JSON.parse(out) as {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: Array<{
                id: string;
                isResolved: boolean;
                comments: { nodes: Array<{ databaseId: number }> };
              }>;
            };
          };
        };
      };
    };
    const thread = data.data.repository.pullRequest.reviewThreads.nodes.find(
      (t) => !t.isResolved && t.comments.nodes.some((c) => c.databaseId === commentId),
    );
    if (!thread) return;
    const mutation = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`;
    await this.run(['api', 'graphql', '-f', `query=${mutation}`, '-F', `id=${thread.id}`]);
  }

  async updateIssueLabels(
    repoFullName: string,
    issueNumber: number,
    labels: { add?: string[]; remove?: string[] },
  ): Promise<void> {
    const args = ['issue', 'edit', String(issueNumber), '--repo', repoFullName];
    for (const l of labels.add ?? []) args.push('--add-label', l);
    for (const l of labels.remove ?? []) args.push('--remove-label', l);
    if (args.length === 5) return;
    await this.run(args);
  }
}
