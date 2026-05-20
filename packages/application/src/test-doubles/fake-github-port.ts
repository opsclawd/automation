import type {
  GitHubPort,
  GitHubIssue,
  PullRequest,
  PrReviewComment,
  CreatePullRequestInput,
} from '../ports/github-port.js';

export class FakeGitHubPort implements GitHubPort {
  issues = new Map<string, GitHubIssue>();
  comments = new Map<string, PrReviewComment[]>();
  repliesPosted: Array<{
    repoFullName: string;
    prNumber: number;
    commentId: number;
    body: string;
  }> = [];
  labelChanges: Array<{
    repoFullName: string;
    issueNumber: number;
    add?: string[];
    remove?: string[];
  }> = [];
  createdPrs: PullRequest[] = [];
  createdPrInputs: CreatePullRequestInput[] = [];

  async getIssue(repoFullName: string, issueNumber: number): Promise<GitHubIssue> {
    const i = this.issues.get(`${repoFullName}/${issueNumber}`);
    if (!i) throw new Error(`no issue ${repoFullName}#${issueNumber}`);
    return i;
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

  async listReviewComments(repoFullName: string, prNumber: number): Promise<PrReviewComment[]> {
    return this.comments.get(`${repoFullName}/${prNumber}`) ?? [];
  }

  async replyToReviewComment(
    repoFullName: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<void> {
    this.repliesPosted.push({ repoFullName, prNumber, commentId, body });
  }

  async updateIssueLabels(
    repoFullName: string,
    issueNumber: number,
    labels: { add?: string[]; remove?: string[] },
  ): Promise<void> {
    this.labelChanges.push({ repoFullName, issueNumber, ...labels });
  }
}
