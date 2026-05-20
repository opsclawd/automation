export type RunId = string & { readonly __brand: 'RunId' };
export type IssueNumber = number & { readonly __brand: 'IssueNumber' };
export type PhaseName = string & { readonly __brand: 'PhaseName' };
export type RepositoryId = string & { readonly __brand: 'RepositoryId' };
export type JobId = string & { readonly __brand: 'JobId' };
export type WorkerId = string & { readonly __brand: 'WorkerId' };

function nonEmpty(name: string, v: string): void {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

export function RunId(v: string): RunId {
  nonEmpty('RunId', v);
  return v as RunId;
}

export function PhaseName(v: string): PhaseName {
  nonEmpty('PhaseName', v);
  return v as PhaseName;
}

export function RepositoryId(v: string): RepositoryId {
  nonEmpty('RepositoryId', v);
  return v as RepositoryId;
}

export function JobId(v: string): JobId {
  nonEmpty('JobId', v);
  return v as JobId;
}

export function WorkerId(v: string): WorkerId {
  nonEmpty('WorkerId', v);
  return v as WorkerId;
}

export function IssueNumber(v: number): IssueNumber {
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`IssueNumber must be a positive integer, got ${v}`);
  }
  return v as IssueNumber;
}
