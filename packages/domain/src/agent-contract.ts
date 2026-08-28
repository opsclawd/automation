export interface AgentContract {
  requiredArtifacts?: string[];
  allowedResultValues?: string[];
  mustNotChangeBranch?: boolean;
  mustNotCreateCommit?: boolean;
  mustCreateCommit?: boolean;
  mustPush?: { remote: string; ref: string };
  mustPostReplies?: { prNumber: number; agentAuthor?: string };
}
