import type { GitPort } from '../ports/git-port.js';

export type NetRevertBaseline =
  | { kind: 'disabled' }
  | { kind: 'captured'; baselineCommitSha: string; targetFiles: string[] }
  | { kind: 'indeterminate'; baselineCommitSha: string; stage: 'capture'; error: string };

export type NetRevertCheck =
  | { kind: 'pass'; currentChangedFiles: string[] }
  | { kind: 'reverted'; revertedFiles: string[]; currentChangedFiles: string[] }
  | { kind: 'indeterminate'; stage: 'capture' | 'final'; error: string };

export async function captureNetRevertBaseline(input: {
  git?: GitPort | undefined;
  cwd: string;
  baselineCommitSha?: string | undefined;
}): Promise<NetRevertBaseline> {
  if (!input.git || !input.baselineCommitSha) return { kind: 'disabled' };
  try {
    const targetFiles = await input.git.changedFiles(input.cwd, input.baselineCommitSha, 'HEAD');
    return {
      kind: 'captured',
      baselineCommitSha: input.baselineCommitSha,
      targetFiles: [...new Set(targetFiles)].sort(),
    };
  } catch (error) {
    return {
      kind: 'indeterminate',
      baselineCommitSha: input.baselineCommitSha,
      stage: 'capture',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkForNetReverts(input: {
  git?: GitPort | undefined;
  cwd: string;
  baseline: NetRevertBaseline;
}): Promise<NetRevertCheck> {
  if (input.baseline.kind === 'disabled') return { kind: 'pass', currentChangedFiles: [] };
  if (input.baseline.kind === 'indeterminate') {
    return { kind: 'indeterminate', stage: 'capture', error: input.baseline.error };
  }
  if (!input.git) {
    return { kind: 'indeterminate', stage: 'final', error: 'GitPort unavailable for comparison' };
  }
  try {
    const currentChangedFiles = await input.git.changedFiles(
      input.cwd,
      input.baseline.baselineCommitSha,
      'HEAD',
    );
    const current = new Set(currentChangedFiles);
    const revertedFiles = input.baseline.targetFiles.filter((path) => !current.has(path));
    return revertedFiles.length > 0
      ? { kind: 'reverted', revertedFiles, currentChangedFiles }
      : { kind: 'pass', currentChangedFiles };
  } catch (error) {
    return {
      kind: 'indeterminate',
      stage: 'final',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
