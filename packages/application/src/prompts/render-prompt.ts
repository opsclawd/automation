import { TemplateError } from './errors.js';
import { ArtifactNotFoundError } from '../ports/artifact-store.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import { WORKSPACE_CONSTRAINTS } from './constants.js';

export interface PromptContext {
  runId: string;
  vars: Record<string, string>;
  artifacts: ArtifactStore;
}

// /g flag required for matchAll — do NOT use with .test() or .exec()
// `artifact?:` is the optional variant: resolves to '' instead of throwing
// when the artifact doesn't exist yet (e.g. a fix prompt referencing review
// findings that only exist after at least one semantic review pass has run —
// a deterministic-check-triggered fix on iteration 1 has none).
const PLACEHOLDER_RE = /\{\{(var|artifact\??):([^}]+)\}\}/g;

function isArtifactNotFoundError(err: unknown): boolean {
  if (err instanceof ArtifactNotFoundError) return true;
  return err instanceof Error && err.name === 'ArtifactNotFoundError';
}

export async function renderPrompt(template: string, ctx: PromptContext): Promise<string> {
  const replacements: Array<{ start: number; end: number; value: string }> = [];

  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    const [full, kind, key] = m;
    const start = m.index!;
    const end = start + full.length;
    let value: string;

    if (kind === 'var') {
      const trimmedKey = key!.trim();
      let v = ctx.vars[trimmedKey];
      if (v === undefined && trimmedKey === 'WORKSPACE_CONSTRAINTS') {
        v = WORKSPACE_CONSTRAINTS;
      }
      if (v === undefined) {
        throw new TemplateError(`unknown var: ${trimmedKey}`, trimmedKey);
      }
      value = v;
    } else {
      const optional = kind === 'artifact?';
      try {
        value = await ctx.artifacts.read(ctx.runId, key!.trim());
      } catch (err) {
        if (isArtifactNotFoundError(err)) {
          if (optional) {
            value = '';
          } else {
            throw new TemplateError(`missing artifact: ${key!}`, key!, { cause: err });
          }
        } else {
          throw err;
        }
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
