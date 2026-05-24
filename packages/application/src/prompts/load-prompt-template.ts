import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TemplateNotFoundError } from './errors.js';

export interface LoadPromptTemplateOpts {
  promptsRoot: string;
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
  const path = join(opts.promptsRoot, phase, `${step}.md`);
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    throw new TemplateNotFoundError(`prompt template not found: ${path}`);
  }
}
