import type {
  GitHubPort,
  GitHubIssue,
  PullRequest,
  PullRequestDetail,
  PullRequestReview,
  GitHubReviewComment,
  CreatePullRequestInput,
} from '../ports/github-port.js';

export class FakeGitHubPort implements GitHubPort {
  issues = new Map<string, GitHubIssue>();
  prs = new Map<string, PullRequestDetail>();
  comments = new Map<string, GitHubReviewComment[]>();
  repliesPosted: Array<{
    repoFullName: string;
    prNumber: number;
    commentId: number;
    body: string;
  }> = [];
  resolvedThreads: Array<{ repoFullName: string; prNumber: number; commentId: number }> = [];
  labelChanges: Array<{
    repoFullName: string;
    issueNumber: number;
    add?: string[];
    remove?: string[];
  }> = [];
  createdPrs: PullRequest[] = [];
  createdPrInputs: CreatePullRequestInput[] = [];
  reviews = new Map<string, PullRequestReview[]>();

  async getIssue(repoFullName: string, issueNumber: number): Promise<GitHubIssue> {
    const i = this.issues.get(`${repoFullName}/${issueNumber}`);
    if (!i) throw new Error(`no issue ${repoFullName}#${issueNumber}`);
    return i;
  }

  async getPr(repoFullName: string, prNumber: number): Promise<PullRequestDetail> {
    const pr = this.prs.get(`${repoFullName}/${prNumber}`);
    if (!pr) throw new Error(`no pr ${repoFullName}#${prNumber}`);
    return pr;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    this.createdPrInputs.push(input);
    const pr: PullRequest = {
      number: this.createdPrs.length + 1,
      url: `https://example/pr/${this.createdPrs.length + 1}`,
      state: 'open',
    };
    this.createdPrs.push(pr);
    return pr;
  }

  async listReviewComments(repoFullName: string, prNumber: number): Promise<GitHubReviewComment[]> {
    return this.comments.get(`${repoFullName}/${prNumber}`) ?? [];
  }

  async listPrCommentsSince(
    repoFullName: string,
    prNumber: number,
    sinceIso: string,
  ): Promise<GitHubReviewComment[]> {
    const all = this.comments.get(`${repoFullName}/${prNumber}`) ?? [];
    const since = new Date(sinceIso);
    return all.filter((c) => c.createdAt >= since);
  }

  async replyToReviewComment(
    repoFullName: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<GitHubReviewComment> {
    this.repliesPosted.push({ repoFullName, prNumber, commentId, body });
    const key = `${repoFullName}/${prNumber}`;
    const existing = this.comments.get(key) ?? [];
    const newComment: GitHubReviewComment = {
      id: existing.length + 9000,
      prNumber,
      path: '',
      line: 0,
      reviewer: 'agent',
      body,
      createdAt: new Date(),
      inReplyToId: commentId,
    };
    existing.push(newComment);
    this.comments.set(key, existing);
    return newComment;
  }

  async resolveReviewThread(
    repoFullName: string,
    prNumber: number,
    commentId: number,
  ): Promise<void> {
    this.resolvedThreads.push({ repoFullName, prNumber, commentId });
  }

  async updateIssueLabels(
    repoFullName: string,
    issueNumber: number,
    labels: { add?: string[]; remove?: string[] },
  ): Promise<void> {
    this.labelChanges.push({ repoFullName, issueNumber, ...labels });
  }

  async listReviews(repoFullName: string, prNumber: number): Promise<PullRequestReview[]> {
    return this.reviews.get(`${repoFullName}/${prNumber}`) ?? [];
  }
}
