import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskManifest } from '@ai-sdlc/application';
import type { LintTaskSizeResult, OversizedTask } from '@ai-sdlc/application';

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$|\.bats$/;
const TEST_CASE_RE = /^\s*(it|test)(\.(skip|only))?\s*\(/gm;

export interface LintTaskSizeConfig {
  maxTestFileLines: number;
  maxTestCases: number;
  blockOversizedTasks: boolean;
}

export function buildLintTaskSize(
  cfg: LintTaskSizeConfig,
): (cwd: string, manifest: TaskManifest) => Promise<LintTaskSizeResult> {
  return async (cwd, manifest) => {
    const oversized: OversizedTask[] = [];

    for (const task of manifest.tasks) {
      const files = task.files ?? [];
      for (const relPath of files) {
        if (!TEST_FILE_RE.test(relPath)) continue;
        const absPath = join(cwd, relPath);
        let content: string;
        try {
          content = await readFile(absPath, 'utf-8');
        } catch {
          // File missing — treat as 0 lines/cases (same as bash `[[ ! -f ]] → continue`)
          continue;
        }
        const lineCount = content.split('\n').length;
        const testCaseCount = (content.match(TEST_CASE_RE) ?? []).length;
        if (lineCount > cfg.maxTestFileLines || testCaseCount > cfg.maxTestCases) {
          oversized.push({
            taskNum: task.n,
            taskTitle: task.title,
            file: relPath,
            lineCount,
            testCaseCount,
          });
        }
      }
    }

    return {
      ok: oversized.length === 0 || !cfg.blockOversizedTasks,
      oversized,
    };
  };
}
