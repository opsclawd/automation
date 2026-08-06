# Integration Review

## Finding 1
- **severity**: high
- **file path**: packages/application/src/phases/handlers/create-pr.ts
- **line reference**: Lines 579, 609
- **evidence**: In `_removeSection` and `_removeValidationSteps`, the `remaining` string is constructed using `body.slice(headerLineEnd + 1)`. The code then attempts to find the next section using `remaining.search(/\n## /)`.
- **failure mode**: Because `body.slice(headerLineEnd + 1)` skips the newline preceding the next section, if the original `body` does not contain a blank line before the next header (i.e. `\n## ` without an extra newline), the `remaining` string will start directly with `## ` instead of `\n## `. The regular expression `/\n## /` will fail to match at the beginning of `remaining`. If there are no other section headers further down, it will evaluate `nextHeaderOffset === -1` and wrongly discard the entirety of `remaining`, silently deleting all subsequent sections from the PR body (e.g., deleting `## Artifacts` and `## Review Findings`). While `_assemblePrSummary` currently injects empty lines, these exported utilities will severely corrupt compactly-spaced markdown or manually edited bodies.
- **required fix**: Retain the newline when extracting the remainder by changing `body.slice(headerLineEnd + 1)` to `body.slice(headerLineEnd)`. This ensures `remaining` always begins with a newline if the next section immediately follows, allowing `/\n## /` to match at index 0 correctly without altering the rest of the slice logic.
