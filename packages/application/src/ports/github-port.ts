export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

export interface PullRequest {
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
}

export interface PrReviewComment {
  id: number;
  prNumber: number;
  path: string;
  line: number;
  reviewer: string;
  body: string;
  createdAt: Date;
}

export interface CreatePullRequestInput {
  repoFullName: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface GitHubPort {
  getIssue(repoFullName: string, issueNumber: number): Promise<GitHubIssue>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  listReviewComments(repoFullName: string, prNumber: number): Promise<PrReviewComment[]>;
  replyToReviewComment(
    repoFullName: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<void>;
  updateIssueLabels(
    repoFullName: string,
    issueNumber: number,
    labels: { add?: string[]; remove?: string[] },
  ): Promise<void>;
}
