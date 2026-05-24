import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TemplateNotFoundError } from './errors.js';

export interface LoadPromptTemplateOpts {
  promptsRoot: string;
}

function validatePathSegment(segment: string, label: string): void {
  if (segment.includes('/') || segment.includes('\\') || segment.includes('..')) {
    throw new TypeError(`invalid ${label}: ${segment} must not contain /, \\, or ..`);
  }
}

/**
 * Load a prompt template from the prompts directory.
 *
 * Lookup rule: resolves to `<promptsRoot>/<phase>/<step>.md`.
 * For example, `loadPromptTemplate('plan-design', 'plan-design', { promptsRoot })`
 * reads `<promptsRoot>/plan-design/plan-design.md`.
 *
 * Throws `TemplateNotFoundError` if the file does not exist.
 */
export function loadPromptTemplate(
  phase: string,
  step: string,
  opts: LoadPromptTemplateOpts,
): string {
  validatePathSegment(phase, 'phase');
  validatePathSegment(step, 'step');
  const path = join(opts.promptsRoot, phase, `${step}.md`);
  try {
    return readFileSync(path, 'utf-8');
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TemplateNotFoundError(`prompt template not found: ${path}`);
    }
    throw e;
  }
}
