export interface TaskManifestEntry {
  n: number;
  title: string;
  files?: string[];
  validation?: string[];
  [key: string]: unknown;
}

export interface TaskManifest {
  version: number;
  task_count: number;
  tasks: TaskManifestEntry[];
  [key: string]: unknown;
}

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

export type PlanTaskListValidationResult = { success: true } | { success: false; error: string };

const TASK_HEADING_RE = /^#{2,3}\s+(Task\b.*)$/i;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripFencedLines(lines: string[]): string[] {
  const result: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      result.push(line);
    }
  }
  return result;
}

function parseTasksNoManifest(planMarkdown: string): { n: number; title: string }[] {
  const lines = planMarkdown.split(/\r?\n/);
  const cleanLines = stripFencedLines(lines);
  const tasks: { n: number; title: string }[] = [];

  const headingRegex = /^#{2,3} Task ([0-9]+):(.*)$/i;
  for (const line of cleanLines) {
    const m = headingRegex.exec(line.trim());
    if (m) {
      tasks.push({
        n: parseInt(m[1]!, 10),
        title: m[2]!.trim(),
      });
    }
  }
  return tasks;
}

function checkSequentialNumbers(planMarkdown: string): string | null {
  const lines = planMarkdown.split(/\r?\n/);
  const cleanLines = stripFencedLines(lines);

  const numbers: number[] = [];
  const regex = /^#{2,3} Task ([0-9]+):/i;
  for (const line of cleanLines) {
    const m = regex.exec(line.trim());
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

function checkDuplicateTitles(titles: string[]): string | null {
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  for (const title of titles) {
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
  const totalFences = lines.filter((line) => /^\s*```/.test(line)).length;
  const cleanLines = stripFencedLines(lines);

  let errors = '';
  const missingFromProse: string[] = [];

  for (const task of manifest.tasks) {
    const headingRegex = new RegExp(`^#{2,3} Task ${task.n}:`, 'i');
    const hasHeading = cleanLines.some((line) => headingRegex.test(line));
    if (!hasHeading) {
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
  const proseTasksRegex = /^#{2,3} Task ([0-9]+):/i;
  const seenExtra = new Set<number>();

  for (const line of cleanLines) {
    const m = proseTasksRegex.exec(line.trim());
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
    if (/^#{2,3} Task [0-9]+:/i.test(line)) {
      break;
    }
    const match = /<!--\s*task-count:\s*([0-9]+)/i.exec(line);
    if (match) {
      val = match[1]!;
    }
  }

  return val ? parseInt(val, 10) : null;
}

function extractBodyFromLine(lines: string[], startLineIdx: number, totalFences: number): string {
  const isOddFences = totalFences % 2 === 1;
  const resultLines: string[] = [];
  let inFence = false;

  const taskHeadingLine = lines[startLineIdx]!;
  const taskLevelMatch = /^#+/.exec(taskHeadingLine);
  const taskLevel = taskLevelMatch ? taskLevelMatch[0].length : 2;

  for (let i = startLineIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;

    if (isOddFences) {
      if (/^#{2,3} Task [0-9]+:/i.test(line)) {
        break;
      }
    } else {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
      }
      if (!inFence) {
        const headingMatch = /^(#{2,3})\s/.exec(line);
        if (headingMatch) {
          const hLevel = headingMatch[1]!.length;
          if (hLevel < taskLevel) {
            break;
          }
          if (hLevel === taskLevel) {
            const isTaskHeading = /^#{2,3} Task [0-9]+:/i.test(line);
            if (taskLevel === 2 || isTaskHeading) {
              break;
            }
          }
        }
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

  if (parsed === null || typeof parsed !== 'object') {
    return { success: false, error: 'manifest validation failed' };
  }

  const parsedObj = parsed as Record<string, unknown>;

  if (parsedObj.version !== 1) {
    return { success: false, error: 'manifest validation failed' };
  }

  if (!Array.isArray(parsedObj.tasks)) {
    return { success: false, error: 'manifest validation failed' };
  }

  if (parsedObj.task_count !== parsedObj.tasks.length) {
    return { success: false, error: 'manifest validation failed' };
  }

  const tasks = parsedObj.tasks as unknown[];
  const ns: number[] = [];

  for (const task of tasks) {
    if (!task || typeof task !== 'object') {
      return { success: false, error: 'manifest validation failed' };
    }
    const tObj = task as Record<string, unknown>;
    if (
      typeof tObj.n !== 'number' ||
      typeof tObj.title !== 'string' ||
      tObj.title.trim().length === 0
    ) {
      return { success: false, error: 'manifest validation failed' };
    }
    ns.push(tObj.n);
  }

  const expectedNs = Array.from({ length: parsedObj.task_count as number }, (_, i) => i + 1);
  const sortedNs = [...ns].sort((a, b) => a - b);
  const isContiguous =
    sortedNs.length === expectedNs.length &&
    sortedNs.every((val, index) => val === expectedNs[index]);
  if (!isContiguous) {
    return { success: false, error: 'manifest validation failed' };
  }

  return { success: true, manifest: parsedObj as unknown as TaskManifest };
}

export function derivePlanTasks(planMarkdown: string, manifest?: TaskManifest): DerivedPlanTask[] {
  if (manifest) {
    return manifest.tasks.map((t) => ({
      index: t.n,
      title: `Task ${t.n}: ${t.title}`,
    }));
  }

  const steps: DerivedPlanTask[] = [];
  for (const line of planMarkdown.split('\n')) {
    const m = TASK_HEADING_RE.exec(line.trim());
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
  const totalFences = lines.filter((line) => /^\s*```/.test(line)).length;

  let lineNum: number | null = null;
  let numberedExhausted = false;

  const numRegex = new RegExp(`^#{2,3} Task ${input.taskNumber}:`, 'i');
  const candidateIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (numRegex.test(lines[i]!)) {
      candidateIndices.push(i);
    }
  }

  for (const candidate of candidateIndices) {
    let fenceCount = 0;
    for (let j = 0; j < candidate; j++) {
      if (/^\s*```/.test(lines[j]!)) {
        fenceCount++;
      }
    }
    if (fenceCount % 2 === 0) {
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
    const escapedTitle = escapeRegExp(input.title);
    const titleRegex = new RegExp(`^#{2,3} Task [0-9]+:.*${escapedTitle}`, 'i');
    const titleCandidates: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (titleRegex.test(lines[i]!)) {
        titleCandidates.push(i);
      }
    }

    for (const candidate of titleCandidates) {
      let fenceCount = 0;
      for (let j = 0; j < candidate; j++) {
        if (/^\s*```/.test(lines[j]!)) {
          fenceCount++;
        }
      }
      if (fenceCount % 2 === 0) {
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
          const escapedTitle = escapeRegExp(input.title!);
          const titleRegex = new RegExp(`^#{2,3} Task [0-9]+:.*${escapedTitle}`, 'i');
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

export function validatePlanTaskList(
  planMarkdown: string,
  manifestJson?: string,
): PlanTaskListValidationResult {
  if (manifestJson && manifestJson.trim() !== '') {
    const manifestResult = parseTaskManifest(manifestJson);
    if (!manifestResult.success) {
      return { success: false, error: manifestResult.error };
    }

    const manifest = manifestResult.manifest;

    const manifestTitles = manifest.tasks.map((t) => t.title);
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

    return { success: true };
  }

  const parsedTasks = parseTasksNoManifest(planMarkdown);
  const parsedCount = parsedTasks.length;

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

  const taskTitles = parsedTasks.map((t) => t.title);
  const dupResult = checkDuplicateTitles(taskTitles);
  if (dupResult) {
    return { success: false, error: dupResult };
  }

  return { success: true };
}
