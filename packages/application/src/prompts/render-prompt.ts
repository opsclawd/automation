import { TemplateError } from './errors.js';
import { ArtifactNotFoundError } from '../ports/artifact-store.js';
import type { ArtifactStore } from '../ports/artifact-store.js';

export interface PromptContext {
  runId: string;
  vars: Record<string, string>;
  artifacts: ArtifactStore;
}

// /g flag required for matchAll — do NOT use with .test() or .exec()
const PLACEHOLDER_RE = /\{\{(var|artifact):([^}]+)\}\}/g;

export async function renderPrompt(template: string, ctx: PromptContext): Promise<string> {
  const replacements: Array<{ start: number; end: number; value: string }> = [];

  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    const [full, kind, key] = m;
    const start = m.index!;
    const end = start + full.length;
    let value: string;

    if (kind === 'var') {
      const v = ctx.vars[key!.trim()];
      if (v === undefined) {
        throw new TemplateError(`unknown var: ${key!}`, key!);
      }
      value = v;
    } else {
      try {
        value = await ctx.artifacts.read(ctx.runId, key!.trim());
      } catch (err) {
        if (err instanceof ArtifactNotFoundError) {
          throw new TemplateError(`missing artifact: ${key!}`, key!, { cause: err });
        }
        throw err;
      }
    }
    replacements.push({ start, end, value });
  }

  let result = '';
  let cursor = 0;
  for (const r of replacements) {
    result += template.slice(cursor, r.start) + r.value;
    cursor = r.end;
  }
  result += template.slice(cursor);
  return result;
}
