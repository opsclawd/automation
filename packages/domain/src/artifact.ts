export type ArtifactType =
  | 'prompt'
  | 'stdout'
  | 'stderr'
  | 'combined_log'
  | 'issue'
  | 'design'
  | 'plan'
  | 'implementation_log'
  | 'validation'
  | 'review'
  | 'fix_log'
  | 'diff'
  | 'result'
  | 'summary'
  | 'pr'
  | 'comment'
  | 'reply'
  | 'run_metadata'
  | 'failure';

export interface Artifact {
  id: string;
  runUuid: string;
  phase?: string;
  type: ArtifactType;
  path: string;
  createdAt: Date;
}
