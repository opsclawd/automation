import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadPromptTemplate, renderPrompt } from '../prompts/index.js';
import { JSON_ESCAPING } from '../prompts/constants.js';
import type { ArtifactStore } from '../ports/artifact-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const promptsRoot = resolve(__dirname, '../../../../prompts');

const TEMPLATES: Array<{ phase: string; step: string }> = [
  { phase: 'review-fix', step: 'follow-up-review' },
  { phase: 'review-fix', step: 'spec-review' },
  { phase: 'review-fix', step: 'whole-change-review' },
  { phase: 'review-fix', step: 'quality-review' },
  { phase: 'review-fix', step: 'narrow-verification' },
  { phase: 'architecture-review', step: 'architecture-review' },
  { phase: 'architecture-review', step: 'architecture-fix' },
  { phase: 'plan-design', step: 'plan-unified' },
  { phase: 'compound', step: 'compound' },
  { phase: 'plan-write', step: 'plan-write' },
  { phase: 'plan-write', step: 'plan-write-repair' },
];

const mockArtifacts: ArtifactStore = {
  async read(_runId: string, relativePath: string) {
    return `# Mock artifact for ${relativePath}`;
  },
  async write() {},
  async list() {
    return [];
  },
  async hydrateWorktree() {},
};

const mockVars = new Proxy<Record<string, string>>(
  {},
  {
    get(_target, prop) {
      if (typeof prop === 'string') {
        if (prop === 'JSON_ESCAPING') {
          return undefined;
        }
        return `mock-${prop}`;
      }
      return undefined;
    },
    has(_target, prop) {
      if (prop === 'JSON_ESCAPING') {
        return false;
      }
      return true;
    },
  },
);

describe('JSON escaping prompt guidance (#1156)', () => {
  it.each(TEMPLATES)(
    'template $phase/$step contains {{var:JSON_ESCAPING}} and renders escaping guidance',
    async ({ phase, step }) => {
      const raw = loadPromptTemplate(phase, step, { promptsRoot });
      expect(raw).toContain('{{var:JSON_ESCAPING}}');

      // Note: we do NOT provide JSON_ESCAPING in vars so renderPrompt uses its built-in fallback
      const rendered = await renderPrompt(raw, {
        runId: 'test-run',
        vars: mockVars,
        artifacts: mockArtifacts,
      });

      expect(rendered).toContain(JSON_ESCAPING);
      expect(rendered).toMatch(
        /All string values in the JSON output must be valid JSON string literals/i,
      );
      expect(rendered).toMatch(/escape every `"` as `\\"` and every backslash as `\\\\`/i);
    },
  );
});
