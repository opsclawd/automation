import { readFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { TaskManifest } from '@ai-sdlc/application';
import type { LintTaskSizeResult, OversizedTask } from '@ai-sdlc/application';

const TEST_FILE_RE = /(?:\b|_|\.)(test|spec)\.(ts|tsx)$|\.bats$/;
const TEST_CASE_RE = /^\s*(it|test|xit|xtest)(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*\s*\(/gm;
const BATS_TEST_CASE_RE = /^\s*@test\s+/gm;

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
        const resolvedCwd = resolve(cwd);
        const resolvedAbsPath = resolve(absPath);
        const rel = relative(resolvedCwd, resolvedAbsPath);
        if (rel.startsWith('..') || isAbsolute(rel)) {
          throw new Error(`Path traversal detected: ${relPath}`);
        }
        let content: string;
        try {
          content = await readFile(absPath, 'utf-8');
        } catch {
          // File missing — treat as 0 lines/cases (same as bash `[[ ! -f ]] → continue`)
          continue;
        }
        const lineCount =
          content === ''
            ? 0
            : (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n').length;
        // Documented limitation: This regex-based test counter is a simplified approach
        // and does not use a full AST parser. To mitigate false positives from test definitions
        // inside comments or multi-line string/template literals, we strip them before matching.
        const isBats = relPath.endsWith('.bats');
        let cleanContent = content;
        if (isBats) {
          cleanContent = cleanContent.replace(/#.*$/gm, ''); // strip single-line comments
        } else {
          cleanContent = cleanContent
            .replace(/\/\*[\s\S]*?\*\//g, '') // strip multiline block comments
            .replace(/\/\/.*$/gm, '') // strip single-line comments
            .replace(/`(\\.|[^`])*`/g, ''); // strip template literals
        }
        const testCaseRe = isBats ? BATS_TEST_CASE_RE : TEST_CASE_RE;
        const testCaseCount = (cleanContent.match(testCaseRe) ?? []).length;
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
