import type { ValidationCommandKind, ValidationCommandOutcome } from '@ai-sdlc/domain';

export function classifyCommandKind(command: string): ValidationCommandKind {
  const c = command.toLowerCase();
  if (c.includes('typecheck') || /\btsc\b/.test(c)) return 'typecheck';
  if (c.includes('lint') || c.includes('eslint')) return 'lint';
  if (c.includes('build')) return 'build';
  if (c.includes('test') || c.includes('vitest') || c.includes('jest')) return 'test';
  return 'other';
}

const MAX_TAIL_LINES = 20;

function tail(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  return lines.slice(-MAX_TAIL_LINES).join('\n');
}

export function summarizeValidationFailure(input: {
  outcome: ValidationCommandOutcome;
  durationMs: number;
  stderr: string;
  stdout: string;
}): string {
  if (input.outcome === 'timed_out') {
    return `timed out after ${input.durationMs}ms`;
  }
  const body = input.stderr.trim().length > 0 ? input.stderr : input.stdout;
  const t = tail(body);
  return t.length > 0 ? t : 'command failed with no captured output';
}
