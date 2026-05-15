// JSON (de)serializer for Run. Centralized here so SQLite mappers, file
// I/O, and any HTTP boundary all round-trip Date fields the same way
// instead of each adapter reinventing it.
//
// The serialized shape is the public Run interface with `Date` fields
// rendered as ISO 8601 strings. JSON.stringify already does this for us;
// the only real work is on the read path, where Date fields come back
// as plain strings unless we coerce them.

import type { Run } from './run.js';

const DATE_KEYS = ['startedAt', 'completedAt'] as const;

export class RunDeserializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunDeserializeError';
  }
}

export function serializeRun(run: Run): string {
  return JSON.stringify(run);
}

export function deserializeRun(input: string | unknown): Run {
  const obj: Record<string, unknown> =
    typeof input === 'string'
      ? (JSON.parse(input) as Record<string, unknown>)
      : (input as Record<string, unknown>);

  for (const key of DATE_KEYS) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    if (v instanceof Date) continue;
    if (typeof v !== 'string') {
      throw new RunDeserializeError(
        `expected ${key} to be an ISO 8601 string or Date; got ${typeof v}`,
      );
    }
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      throw new RunDeserializeError(`invalid ISO 8601 date for ${key}: ${v}`);
    }
    obj[key] = d;
  }

  return obj as unknown as Run;
}
