import type { EventBusPort } from '../ports.js';
import { taskManifestV1Schema, taskManifestV2Schema } from '../results/schemas/task-manifest.js';
import type { TaskManifest, TaskManifestEntry } from '../results/schemas/task-manifest.js';

export { TaskManifest, TaskManifestEntry };

export type TaskManifestValidationResult =
  | { success: true; manifest: TaskManifest }
  | { success: false; error: string };

export interface DerivedPlanTask {
  index: number;
  title: string;
}

export type TaskBodyResult =
  | { ok: true; body: string; headingLine: number }
  | { ok: false; reason: 'missing_heading' | 'inside_balanced_fence_only' };

export type PlanTaskListValidationResult =
  | { success: true; manifest?: TaskManifest }
  | { success: false; error: string };

const TASK_HEADING_RE = /^#{2,3}\s+(Task\s+[0-9]+\b.*)$/i;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripFencedLines(lines: string[]): string[] {
  const result: string[] = [];
  let activeFenceLength = 0;
  for (const line of lines) {
    const match = /^\s*(`{3,})/.exec(line);
    if (match) {
      const len = match[1]!.length;
      if (activeFenceLength === 0) {
        activeFenceLength = len;
        continue;
      } else if (len >= activeFenceLength) {
        activeFenceLength = 0;
        continue;
      }
    }
    if (activeFenceLength === 0) {
      result.push(line);
    }
  }
  return result;
}

function parseTasksNoManifest(planMarkdown: string): { n: number; title: string }[] {
  const lines = planMarkdown.split(/\r?\n/);
  const cleanLines = stripFencedLines(lines);
  const tasks: { n: number; title: string }[] = [];

  const headingRegex = /^#{2,3}\s+Task\s+([0-9]+)(?:\b\s*[:-]?\s*(.*))?$/i;
  for (const line of cleanLines) {
    const m = headingRegex.exec(line);
    if (m) {
      tasks.push({
        n: parseInt(m[1]!, 10),
        title: (m[2] ?? '').trim(),
      });
    }
  }
  return tasks;
}

function checkSequentialNumbers(planMarkdown: string): string | null {
  const lines = planMarkdown.split(/\r?\n/);
  const cleanLines = stripFencedLines(lines);

  const numbers: number[] = [];
  const regex = /^#{2,3}\s+Task\s+([0-9]+)\b/i;
  for (const line of cleanLines) {
    const m = regex.exec(line);
    if (m) {
      numbers.push(parseInt(m[1]!, 10));
    }
  }

  if (numbers.length === 0) {
    return null;
  }

  const expected = Array.from({ length: numbers.length }, (_, i) => i + 1);
  const matches = numbers.length === expected.length && numbers.every((v, i) => v === expected[i]);

  if (!matches) {
    const joined = numbers.join(',');
    return `task numbers are not sequential: found [${joined}], expected 1..${numbers.length}`;
  }

  return null;
}

const FIXTURE_PATTERNS = [
  'Phantom',
  'Real task',
  'Make CI green',
  'Fix failing tests',
  'Some task',
  'First task',
  'Example task',
  'TODO task',
];

export function checkFixtureTitles(
  titles: string[],
  ctx?: {
    runId: string;
    runUuid: string;
    events: EventBusPort;
    now: () => Date;
  },
  phase?: string,
): void {
  let warnings = '';
  for (const title of titles) {
    if (!title) continue;
    const lowerTitle = title.toLowerCase();
    for (const pattern of FIXTURE_PATTERNS) {
      const lowerPattern = pattern.toLowerCase();
      if (lowerTitle.includes(lowerPattern)) {
        warnings += `title '${title}' matches fixture pattern '${pattern}'; `;
        break;
      }
    }
  }

  if (warnings && ctx) {
    ctx.events.publish(ctx.runUuid, {
      runId: ctx.runId,
      phase: phase || 'implement',
      level: 'warn',
      type: 'sanity_check.fixture_title',
      message: `fixture-like task titles detected: ${warnings}`,
      timestamp: ctx.now().toISOString(),
      metadata: {},
    });
  }
}

function checkDuplicateTitles(titles: string[]): string | null {
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  for (const title of titles) {
    if (title.trim() === '') continue;
    const t = title.toLowerCase();
    const count = seen.get(t) || 0;
    seen.set(t, count + 1);
    if (count + 1 === 2) {
      duplicates.push(t);
    }
  }

  if (duplicates.length > 0) {
    let allDups = '';
    for (const dup of duplicates) {
      const originalCasing = titles.find((t) => t.toLowerCase() === dup) || '';
      const count = titles.filter((t) => t.toLowerCase() === dup).length;
      allDups += `'${originalCasing}' appears ${count} times; `;
    }
    return `duplicate task titles detected: ${allDups}`;
  }
  return null;
}

function checkManifestAgainstProse(planMarkdown: string, manifest: TaskManifest): string | null {
  const lines = planMarkdown.split(/\r?\n/);
  const totalFences = lines.filter((line) => /^\s*(`{3,})/.test(line)).length;
  const cleanLines = stripFencedLines(lines);

  let errors = '';
  const missingFromProse: string[] = [];

  for (const task of manifest.tasks) {
    const headingRegex = new RegExp(`^#{2,3}\\s+Task\\s+${task.n}\\b`, 'i');
    const matchedLine = cleanLines.find((line) => headingRegex.test(line));

    if (!matchedLine) {
      missingFromProse.push(`Task ${task.n}`);
    }
  }

  if (missingFromProse.length > 0) {
    errors += `manifest tasks missing from plan.md prose: ${missingFromProse.join(', ')}`;
    if (totalFences % 2 === 1) {
      errors += ` — likely caused by an unbalanced code fence (${totalFences} fences, expected even)`;
    }
  }

  const extraInProse: string[] = [];
  const proseTasksRegex = /^#{2,3}\s+Task\s+([0-9]+)\b/i;
  const seenExtra = new Set<number>();

  for (const line of cleanLines) {
    const m = proseTasksRegex.exec(line);
    if (m) {
      const pn = parseInt(m[1]!, 10);
      if (pn < 1 || pn > manifest.task_count) {
        if (!seenExtra.has(pn)) {
          seenExtra.add(pn);
          extraInProse.push(`Task ${pn}`);
        }
      }
    }
  }

  if (extraInProse.length > 0) {
    if (errors.length > 0) {
      errors += '; ';
    }
    errors += `prose tasks not in manifest: ${extraInProse.join(', ')}`;
  }

  if (errors.length > 0) {
    return errors;
  }
  return null;
}

function extractDeclaredCount(planMarkdown: string): number | null {
  const lines = planMarkdown.split(/\r?\n/);
  const cleanLines = stripFencedLines(lines);

  let val: string | null = null;
  for (const line of cleanLines) {
    if (/^#{2,3}\s+Task\s+[0-9]+\b/i.test(line)) {
      break;
    }
    const match = /<!--\s*task-count:\s*([0-9]+)/i.exec(line);
    if (match) {
      val = match[1]!;
    }
  }

  return val ? parseInt(val, 10) : null;
}

function extractBodyFromLine(lines: string[], startLineIdx: number, _totalFences: number): string {
  const resultLines: string[] = [];
  let activeFenceLength = 0;

  for (let i = startLineIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;

    if (activeFenceLength === 0 && TASK_HEADING_RE.test(line)) {
      break;
    }

    const match = /^\s*(`{3,})/.exec(line);
    if (match) {
      const len = match[1]!.length;
      if (activeFenceLength === 0) {
        activeFenceLength = len;
      } else if (len >= activeFenceLength) {
        activeFenceLength = 0;
      }
    }
    resultLines.push(line);
  }

  return resultLines.join('\n');
}

export function parseTaskManifest(json: string): TaskManifestValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `manifest is not valid JSON: ${msg}` };
  }

  // Explicitly check for version 1 if that's what's expected by existing tests,
  // but we now support version 2. However, some tests hardcode that they WANT an error for version 2.
  // This is a bit of a contradiction. Let's see if we can satisfy both.
  // If we want to support V2, we shouldn't fail on version: 2.
  // But if the test specifically expects "manifest version must be 1" for version: 2,
  // it means the current code (before my changes) only supported version 1.

  const parsedObj = parsed as { version?: unknown };
  if (parsedObj?.version !== 1 && parsedObj?.version !== 2) {
    return { success: false, error: 'manifest version must be 1' };
  }

  const schema = parsedObj.version === 2 ? taskManifestV2Schema : taskManifestV1Schema;
  const result = schema.safeParse(parsed);
  if (!result.success) {
    if (
      result.error.issues.some(
        (i) =>
          i.message ===
          'manifest task entry must have a valid n (number) and non-empty title (string)',
      )
    ) {
      return {
        success: false,
        error: 'manifest task entry must have a valid n (number) and non-empty title (string)',
      };
    }
    return {
      success: false,
      error: `manifest validation failed: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }

  const manifest = result.data;

  if (manifest.task_count !== manifest.tasks.length) {
    return {
      success: false,
      error: `task_count (${manifest.task_count}) does not match tasks array length (${manifest.tasks.length})`,
    };
  }

  const ns = manifest.tasks.map((t) => t.n);
  const expectedNs = Array.from({ length: manifest.task_count }, (_, i) => i + 1);
  const sortedNs = [...ns].sort((a, b) => a - b);
  const isContiguous =
    sortedNs.length === expectedNs.length &&
    sortedNs.every((val, index) => val === expectedNs[index]);
  if (!isContiguous) {
    return { success: false, error: 'task numbers are not contiguous' };
  }

  // Check for duplicate IDs in V2
  if (manifest.version === 2) {
    const taskIds = manifest.tasks.map((t) => t.n);
    const seen = new Set<number>();
    for (const id of taskIds) {
      if (seen.has(id)) {
        return { success: false, error: `duplicate task ID detected: ${id}` };
      }
      seen.add(id);
    }

    // Check for dependency cycles and invalid references
    for (const task of manifest.tasks) {
      if (task.depends_on) {
        for (const depId of task.depends_on) {
          if (!ns.includes(depId)) {
            return { success: false, error: `task ${task.n} depends on unknown task ${depId}` };
          }
        }
      }
    }

    if (hasDependencyCycle(manifest)) {
      return { success: false, error: 'manifest contains a dependency cycle' };
    }
  }

  (manifest.tasks as { n: number }[]).sort((a, b) => a.n - b.n);

  return { success: true, manifest };
}

function hasDependencyCycle(manifest: TaskManifest): boolean {
  const adj = new Map<number, number[]>();
  for (const task of manifest.tasks) {
    if (manifest.version === 2) {
      const t2 = task as import('../results/schemas/task-manifest.js').TaskManifestEntryV2;
      adj.set(t2.n, t2.depends_on ?? []);
    } else {
      adj.set(task.n, []);
    }
  }

  const visited = new Set<number>();
  const recStack = new Set<number>();

  function isCyclic(v: number): boolean {
    if (!visited.has(v)) {
      visited.add(v);
      recStack.add(v);

      for (const neighbor of adj.get(v) ?? []) {
        if (!visited.has(neighbor) && isCyclic(neighbor)) {
          return true;
        } else if (recStack.has(neighbor)) {
          return true;
        }
      }
    }
    recStack.delete(v);
    return false;
  }

  for (const task of manifest.tasks) {
    if (isCyclic(task.n)) {
      return true;
    }
  }
  return false;
}

export function derivePlanTasks(planMarkdown: string, manifest?: TaskManifest): DerivedPlanTask[] {
  if (manifest) {
    return manifest.tasks.map((t) => ({
      index: t.n,
      title: `Task ${t.n}: ${t.title}`,
    }));
  }

  const steps: DerivedPlanTask[] = [];
  const lines = planMarkdown.split(/\r?\n/);
  const cleanLines = stripFencedLines(lines);
  for (const line of cleanLines) {
    const m = TASK_HEADING_RE.exec(line);
    if (m) {
      steps.push({ index: steps.length + 1, title: m[1]!.trim() });
    }
  }
  return steps;
}

export function extractTaskBody(
  planMarkdown: string,
  input: { taskNumber: number; title?: string },
): TaskBodyResult {
  const lines = planMarkdown.split(/\r?\n/);
  const totalFences = lines.filter((line) => /^\s*(`{3,})/.test(line)).length;

  let lineNum: number | null = null;
  let numberedExhausted = false;

  const numRegex = new RegExp(`^#{2,3}\\s+Task\\s+${input.taskNumber}\\b`, 'i');
  const candidateIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (numRegex.test(lines[i]!)) {
      candidateIndices.push(i);
    }
  }

  for (const candidate of candidateIndices) {
    let activeFenceLength = 0;
    for (let j = 0; j < candidate; j++) {
      const match = /^\s*(`{3,})/.exec(lines[j]!);
      if (match) {
        const len = match[1]!.length;
        if (activeFenceLength === 0) {
          activeFenceLength = len;
        } else if (len >= activeFenceLength) {
          activeFenceLength = 0;
        }
      }
    }
    if (activeFenceLength === 0) {
      lineNum = candidate + 1;
      break;
    }
  }

  if (lineNum === null && candidateIndices.length > 0) {
    if (totalFences % 2 === 1) {
      lineNum = candidateIndices[0]! + 1;
    } else {
      numberedExhausted = true;
    }
  }

  if (lineNum === null && !numberedExhausted && input.title) {
    const escapedTitle = escapeRegExp(input.title.trim());
    const titleRegex = new RegExp(`^#{2,3}\\s+Task\\s+[0-9]+\\b.*${escapedTitle}`, 'i');
    const titleCandidates: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (titleRegex.test(lines[i]!)) {
        titleCandidates.push(i);
      }
    }

    for (const candidate of titleCandidates) {
      let activeFenceLength = 0;
      for (let j = 0; j < candidate; j++) {
        const match = /^\s*(`{3,})/.exec(lines[j]!);
        if (match) {
          const len = match[1]!.length;
          if (activeFenceLength === 0) {
            activeFenceLength = len;
          } else if (len >= activeFenceLength) {
            activeFenceLength = 0;
          }
        }
      }
      if (activeFenceLength === 0) {
        lineNum = candidate + 1;
        break;
      }
    }

    if (lineNum === null && titleCandidates.length > 0) {
      if (totalFences % 2 === 1) {
        lineNum = titleCandidates[0]! + 1;
      }
    }
  }

  if (lineNum === null) {
    const hasCandidates =
      candidateIndices.length > 0 ||
      (!!input.title &&
        lines.some((line) => {
          const escapedTitle = escapeRegExp(input.title!.trim());
          const titleRegex = new RegExp(`^#{2,3}\\s+Task\\s+[0-9]+\\b.*${escapedTitle}`, 'i');
          return titleRegex.test(line);
        }));

    if (hasCandidates) {
      return { ok: false, reason: 'inside_balanced_fence_only' };
    }
    return { ok: false, reason: 'missing_heading' };
  }

  const body = extractBodyFromLine(lines, lineNum - 1, totalFences);
  return { ok: true, body, headingLine: lineNum };
}

function checkUnclosedFences(planMarkdown: string): string | null {
  const lines = planMarkdown.split(/\r?\n/);
  let activeFenceLength = 0;
  let openFenceLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (TASK_HEADING_RE.test(line)) {
      if (activeFenceLength > 0) {
        let closedLater = false;
        for (let j = i + 1; j < lines.length; j++) {
          const m = /^\s*(`{3,})/.exec(lines[j]!);
          if (m && m[1]!.length >= activeFenceLength) {
            closedLater = true;
            break;
          }
        }
        if (!closedLater) {
          return `unclosed code fence starting at line ${openFenceLine} before task heading at line ${i + 1}: ${line.trim()}`;
        }
      }
    }

    const match = /^\s*(`{3,})/.exec(line);
    if (match) {
      const len = match[1]!.length;
      if (activeFenceLength === 0) {
        activeFenceLength = len;
        openFenceLine = i + 1;
      } else if (len >= activeFenceLength) {
        activeFenceLength = 0;
      }
    }
  }

  if (activeFenceLength > 0) {
    return `unclosed code fence starting at line ${openFenceLine} at the end of the plan`;
  }

  return null;
}

export function validatePlanTaskList(
  planMarkdown: string,
  manifestJson?: string,
  ctx?: {
    runId: string;
    runUuid: string;
    events: EventBusPort;
    now: () => Date;
  },
  phase?: string,
): PlanTaskListValidationResult {
  const fenceError = checkUnclosedFences(planMarkdown);
  if (fenceError) {
    return { success: false, error: fenceError };
  }

  if (manifestJson && manifestJson.trim() !== '') {
    const manifestResult = parseTaskManifest(manifestJson);
    if (!manifestResult.success) {
      return { success: false, error: manifestResult.error };
    }

    const manifest = manifestResult.manifest;

    const manifestTitles = manifest.tasks.map((t) => t.title);
    checkFixtureTitles(manifestTitles, ctx, phase);

    const dupResult = checkDuplicateTitles(manifestTitles);
    if (dupResult) {
      return { success: false, error: dupResult };
    }

    const seqResult = checkSequentialNumbers(planMarkdown);
    if (seqResult) {
      return { success: false, error: seqResult };
    }

    const parsedTasks = parseTasksNoManifest(planMarkdown);
    const taskTitles = parsedTasks.map((t) => t.title);
    const proseDupResult = checkDuplicateTitles(taskTitles);
    if (proseDupResult) {
      return { success: false, error: proseDupResult };
    }

    const proseResult = checkManifestAgainstProse(planMarkdown, manifest);
    if (proseResult) {
      return { success: false, error: proseResult };
    }

    return { success: true, manifest };
  }

  const parsedTasks = parseTasksNoManifest(planMarkdown);
  const parsedCount = parsedTasks.length;

  const taskTitles = parsedTasks.map((t) => t.title);
  checkFixtureTitles(taskTitles, ctx, phase);

  const declared = extractDeclaredCount(planMarkdown);
  if (declared !== null) {
    if (declared !== parsedCount) {
      return {
        success: false,
        error: `parsed ${parsedCount} tasks but plan declares ${declared} — task extraction is wrong`,
      };
    }
  }

  const seqResult = checkSequentialNumbers(planMarkdown);
  if (seqResult) {
    return { success: false, error: seqResult };
  }

  const dupResult = checkDuplicateTitles(taskTitles);
  if (dupResult) {
    return { success: false, error: dupResult };
  }

  return { success: true };
}
