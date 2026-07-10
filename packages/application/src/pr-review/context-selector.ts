import { GitPort } from '../ports/git-port.js';
import { PrReviewComment } from '@ai-sdlc/domain';
import { join, dirname, basename } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

export interface ContextSelectorInput {
  cwd: string;
  comments: PrReviewComment[];
  attempt: number;
  diff: string; // current full diff origin/HEAD..HEAD (or similar)
  previousBuildError: string | undefined;
  previousCodeVerifyReason: string | undefined;
}

export interface SelectedContext {
  comments: {
    commentId: number;
    path: string;
    line: number;
    body: string;
    context: string;
  }[];
  files: {
    path: string;
    content: string;
  }[];
  diffs: {
    path?: string;
    content: string;
  }[];
  diffStats: string;
  additionalInfo?: string;
}

export class ContextSelector {
  constructor(private readonly git: GitPort) {}

  async select(input: ContextSelectorInput): Promise<SelectedContext> {
    const { attempt } = input;

    if (attempt === 1) {
      return this.selectTier1(input);
    } else if (attempt === 2) {
      return this.selectTier2(input);
    } else {
      return this.selectTier3(input);
    }
  }

  private async selectTier1(input: ContextSelectorInput): Promise<SelectedContext> {
    const { comments, cwd, diff } = input;
    const selectedComments = [];
    const files = new Map<string, string>();
    const diffs = [];

    const diffStats = await this.git.diffStat(cwd, 'origin/HEAD');

    for (const comment of comments) {
      const hunk = this.extractHunk(diff, comment.path, comment.line);
      const sourceContext = this.extractSourceContext(cwd, comment.path, comment.line, 10);

      selectedComments.push({
        commentId: comment.commentId,
        path: comment.path,
        line: comment.line,
        body: comment.body,
        context: `Hunk:\n${hunk}\n\nSource Context:\n${sourceContext}`,
      });

      // Referenced symbol definition
      const symbols = this.resolveSymbols(comment.body, cwd, comment.path);
      for (const s of symbols) {
        files.set(s.path, s.content);
      }

      // Associated tests
      const tests = this.findAssociatedTests(cwd, comment.path);
      for (const t of tests) {
        files.set(t.path, t.content);
      }

      if (hunk) {
        diffs.push({ path: comment.path, content: hunk });
      }
    }

    return {
      comments: selectedComments,
      files: Array.from(files.entries()).map(([path, content]) => ({ path, content })),
      diffs,
      diffStats,
    };
  }

  private async selectTier2(input: ContextSelectorInput): Promise<SelectedContext> {
    const { comments, cwd, previousBuildError, previousCodeVerifyReason } = input;
    const selectedComments = [];
    const files = new Map<string, string>();
    const diffs = [];

    const diffStats = await this.git.diffStat(cwd, 'origin/HEAD');

    for (const comment of comments) {
      const pathDiff = await this.getPathDiff(cwd, 'origin/HEAD', comment.path);

      selectedComments.push({
        commentId: comment.commentId,
        path: comment.path,
        line: comment.line,
        body: comment.body,
        context: `Full file diff for ${comment.path} included in Diffs section.`,
      });

      diffs.push({ path: comment.path, content: pathDiff });

      // Referenced interfaces, callers, or implementations
      const references = await this.resolveReferences(cwd, comment.path);
      for (const r of references) {
        files.set(r.path, r.content);
      }
    }

    let additionalInfo = '';
    if (previousBuildError) {
      additionalInfo += `### Previous Build Error\n\n${previousBuildError}\n\n`;
    }
    if (previousCodeVerifyReason) {
      additionalInfo += `### Previous Code Verification Rejection\n\n> ${previousCodeVerifyReason}\n\n`;
    }

    return {
      comments: selectedComments,
      files: Array.from(files.entries()).map(([path, content]) => ({ path, content })),
      diffs,
      diffStats,
      additionalInfo,
    };
  }

  private async selectTier3(input: ContextSelectorInput): Promise<SelectedContext> {
    const { comments, cwd, diff } = input;
    const diffStats = await this.git.diffStat(cwd, 'origin/HEAD');

    // Attempt 3 expansion: filtered related-file diffs, bounded cross-file context
    // For now, full PR diff is included.

    return {
      comments: comments.map(c => ({
        commentId: c.commentId,
        path: c.path,
        line: c.line,
        body: c.body,
        context: 'Full PR diff included as requested for Attempt 3.',
      })),
      files: [],
      diffs: [{ content: diff }],
      diffStats,
    };
  }

  private async getPathDiff(cwd: string, base: string, path: string): Promise<string> {
    const fullDiff = await this.git.diff(cwd, base);
    return this.filterDiffByPath(fullDiff, path);
  }

  private filterDiffByPath(diff: string, path: string): string {
    const lines = diff.split('\n');
    const result = [];
    let include = false;
    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        include = line.includes(` a/${path} `) || line.endsWith(` b/${path}`);
      }
      if (include) {
        result.push(line);
      }
    }
    return result.join('\n');
  }

  private extractHunk(diff: string, path: string, line: number): string {
    const lines = diff.split('\n');
    let inPath = false;
    let hunkStartLine = 0;
    let hunkEndLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.startsWith('diff --git')) {
        inPath = l.includes(` a/${path} `) || l.endsWith(` b/${path}`);
        continue;
      }
      if (inPath && l.startsWith('@@')) {
        const m = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
        if (m) {
          const oldStart = parseInt(m[1]!, 10);
          const oldLen = m[2] ? parseInt(m[2]!, 10) : 1;
          hunkStartLine = oldStart;
          hunkEndLine = oldStart + oldLen;

          if (line >= hunkStartLine && line <= hunkEndLine) {
            const currentHunk = [l];
            let j = i + 1;
            while (j < lines.length && !lines[j]!.startsWith('@@') && !lines[j]!.startsWith('diff --git')) {
              currentHunk.push(lines[j]!);
              j++;
            }
            return currentHunk.join('\n');
          }
        }
      }
    }
    return '';
  }

  private extractSourceContext(cwd: string, path: string, line: number, window: number): string {
    try {
      const fullPath = join(cwd, path);
      if (!existsSync(fullPath)) return '';
      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(0, line - window - 1);
      const end = Math.min(lines.length, line + window);
      return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
    } catch {
      return '';
    }
  }

  private resolveSymbols(body: string, cwd: string, currentPath: string): { path: string; content: string }[] {
    const symbols = (body.match(/`([^`]+)`/g) || []).map(s => s.slice(1, -1));
    const results: { path: string; content: string }[] = [];

    const currentDir = dirname(join(cwd, currentPath));
    for (const sym of symbols) {
      // Check if it's a file
      const potentialPath = join(currentDir, sym);
      if (existsSync(potentialPath) && !potentialPath.endsWith('/') && results.length < 5) {
        try {
          results.push({ path: sym, content: readFileSync(potentialPath, 'utf-8').slice(0, 2000) });
          continue;
        } catch {}
      }

      // Try to find definition in current file or nearby files via simple grep
      try {
        const grepCmd = `grep -rwnl "${sym}" --include="*.ts" --include="*.js" "${currentDir}" | head -n 3`;
        const filesWithSym = execSync(grepCmd, { encoding: 'utf-8' }).split('\n').filter(Boolean);
        for (const f of filesWithSym) {
          if (results.length >= 5) break;
          const relPath = f.replace(cwd + '/', '');
          if (results.some(r => r.path === relPath)) continue;
          results.push({ path: relPath, content: readFileSync(f, 'utf-8').slice(0, 2000) });
        }
      } catch {
        // ignore grep failures
      }
    }
    return results;
  }

  private findAssociatedTests(cwd: string, path: string): { path: string; content: string }[] {
    const results: { path: string; content: string }[] = [];
    const base = basename(path).split('.')[0];
    if (!base) return [];

    const dir = dirname(path);
    const potentialTests = [
      join(dir, `${base}.test.ts`),
      join(dir, `${base}.spec.ts`),
      join(dir, '__tests__', `${base}.test.ts`),
      join(dir, '__tests__', `${base}.ts`),
      join('tests', `${base}.test.ts`),
    ];

    for (const t of potentialTests) {
      const fullPath = join(cwd, t);
      if (existsSync(fullPath) && results.length < 2) {
        try {
          results.push({ path: t, content: readFileSync(fullPath, 'utf-8').slice(0, 5000) });
        } catch {}
      }
    }
    return results;
  }

  private async resolveReferences(cwd: string, path: string): Promise<{ path: string; content: string }[]> {
    // Attempt 2: find interfaces/implementations
    const results: { path: string; content: string }[] = [];
    try {
      const content = readFileSync(join(cwd, path), 'utf-8');
      const imports = content.match(/import .* from ['"](.*)['"]/g) || [];
      for (const imp of imports) {
        const m = imp.match(/from ['"](.*)['"]/);
        if (m && m[1]) {
          let target = m[1];
          if (target.startsWith('.')) {
            target = join(dirname(path), target);
          }
          const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts'];
          for (const ext of extensions) {
            const fullPath = join(cwd, target + ext);
            if (existsSync(fullPath) && !results.some(r => r.path === target + ext)) {
              results.push({ path: target + ext, content: readFileSync(fullPath, 'utf-8').slice(0, 3000) });
              break;
            }
          }
        }
        if (results.length >= 5) break;
      }
    } catch {
      // ignore
    }
    return results;
  }
}
