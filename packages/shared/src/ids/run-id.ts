import { v4 as uuidv4 } from 'uuid';

export interface NewRunIdInput {
  issueNumber: number;
  now: Date;
}

export interface RunIdentity {
  uuid: string;
  displayId: string;
}

export function newRunId(input: NewRunIdInput): RunIdentity {
  const ts = formatTimestamp(input.now);
  return {
    uuid: uuidv4(),
    displayId: `issue-${input.issueNumber}-${ts}`,
  };
}

function formatTimestamp(d: Date): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${pad(d.getUTCMilliseconds(), 3)}`
  );
}
