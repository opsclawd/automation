/**
 * Checks if a unified diff contains any hunks that are within a certain window
 * of a target line.
 *
 * @param diff - The unified diff text.
 * @param targetLine - The line number to check proximity to. If 0, any change
 *                     in the file is considered "near".
 * @param window - The number of lines to allow as proximity. Defaults to 10.
 * @returns true if any change is near the target line, false otherwise.
 */
export function isDiffNearLine(diff: string, targetLine: number, window = 10): boolean {
  if (!diff.trim()) {
    return false;
  }

  if (targetLine === 0) {
    return true;
  }

  // Use the original (-) side line numbers because PR review comments are
  // anchored to the state of the code BEFORE the fix was applied.
  const hunkHeaderRegex = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm;
  let match;

  while ((match = hunkHeaderRegex.exec(diff)) !== null) {
    const start = parseInt(match[1]!, 10);
    const count = match[2] ? parseInt(match[2], 10) : 1;
    const end = start + Math.max(0, count - 1);

    // Check if the hunk overlaps with [targetLine - window, targetLine + window]
    if (start <= targetLine + window && end >= targetLine - window) {
      return true;
    }
  }

  return false;
}
