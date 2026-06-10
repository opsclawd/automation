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

/** PR metadata including branch name, used by the poller. */
export interface PullRequestDetail extends PullRequest {
  headRefName: string;
}

/** Raw GitHub review comment (wire shape from REST API).
 *  Distinct from the persisted `PrReviewComment` domain record in @ai-sdlc/domain. */
export interface GitHubReviewComment {
  id: number;
  prNumber: number;
  path: string;
  line: number | null;
  reviewer: string;
  body: string;
  createdAt: Date;
  /** Present when this comment is itself a reply to another comment. */
  inReplyToId?: number;
  /** The pull request review ID this inline comment belongs to (from pull_request_review_id). Used for APPROVED review filtering. */
  reviewId?: number;
}

export interface CreatePullRequestInput {
  repoFullName: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface PullRequestReview {
  id: number;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENT' | 'PENDING';
  user: string;
}

export interface GitHubPort {
  getIssue(repoFullName: string, issueNumber: number): Promise<GitHubIssue>;
  getPr(repoFullName: string, prNumber: number): Promise<PullRequestDetail>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  listReviewComments(repoFullName: string, prNumber: number): Promise<GitHubReviewComment[]>;
  listPrCommentsSince(
    repoFullName: string,
    prNumber: number,
    sinceIso: string,
  ): Promise<GitHubReviewComment[]>;
  replyToReviewComment(
    repoFullName: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<void>;
  resolveReviewThread(repoFullName: string, prNumber: number, commentId: number): Promise<void>;
  updateIssueLabels(
    repoFullName: string,
    issueNumber: number,
    labels: { add?: string[]; remove?: string[] },
  ): Promise<void>;
  listReviews(repoFullName: string, prNumber: number): Promise<PullRequestReview[]>;
}
