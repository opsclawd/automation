export interface DerivedStep {
  index: number;
  title: string;
}

const TASK_HEADING_RE = /^##\s+(Task\b.*)$/i;

/** Deterministically derive ordered Steps from plan.md markdown.
 *
 *  Each second-level heading matching `## Task ...` (case-insensitive,
 *  with word-boundary after "Task") produces one `DerivedStep`.
 *  Steps are numbered 1..N in document order.
 *
 *  Heading levels other than `##` (second-level) are ignored.
 *  Headings that do not match the "Task" word-boundary pattern
 *  (e.g. `## Notes`, `## Taskforce`) are silently skipped.
 *
 *  This matches the Bash `implement-task-N` heading convention. */
export function deriveSteps(planMarkdown: string): DerivedStep[] {
  const steps: DerivedStep[] = [];
  for (const line of planMarkdown.split('\n')) {
    const m = TASK_HEADING_RE.exec(line.trim());
    if (m) {
      steps.push({ index: steps.length + 1, title: m[1]!.trim() });
    }
  }
  return steps;
}
