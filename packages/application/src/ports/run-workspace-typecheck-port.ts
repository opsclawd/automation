export interface RunWorkspaceTypecheckInput {
  cwd: string;
}

export interface RunWorkspaceTypecheckResult {
  ok: boolean;
  error?: string;
}

export interface RunWorkspaceTypecheckPort {
  (input: RunWorkspaceTypecheckInput): Promise<RunWorkspaceTypecheckResult>;
}