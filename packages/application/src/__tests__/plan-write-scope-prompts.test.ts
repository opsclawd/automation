import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadPromptTemplate } from '../prompts/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const promptsRoot = resolve(__dirname, '../../../../prompts');

describe('plan-write scope prompts', () => {
  it('plan-write prompts distinguish required files from bounded optional permissions', () => {
    const planWritePrompt = loadPromptTemplate('plan-write', 'plan-write', { promptsRoot });

    // Assert V2 schema example contains all scope fields
    expect(planWritePrompt).toContain('"expected_files"');
    expect(planWritePrompt).toContain('"permitted_areas"');
    expect(planWritePrompt).toContain('"may_extend"');
    expect(planWritePrompt).toContain('"non_goals"');
    expect(planWritePrompt).toContain('"reference_files"');

    // Assert field documentation distinguishes obligations from permissions
    expect(planWritePrompt).toMatch(/tasks\[\]\.expected_files/);
    expect(planWritePrompt).toMatch(/tasks\[\]\.permitted_areas/);
    expect(planWritePrompt).toMatch(/tasks\[\]\.may_extend/);
    expect(planWritePrompt).toMatch(/tasks\[\]\.non_goals/);
    expect(planWritePrompt).toMatch(/tasks\[\]\.reference_files/);

    // Obligation vs permission semantics
    expect(planWritePrompt).toMatch(/must modify and commit/i);
    expect(planWritePrompt).toMatch(/optional/i);
    expect(planWritePrompt).toMatch(/tracked/i);
    expect(planWritePrompt).toMatch(/read-only/i);

    // Assert removal of obsolete instruction that every modified file must be in expected_files
    expect(planWritePrompt).not.toContain(
      'Any file actually modified during the task MUST be listed in expected_files',
    );
    expect(planWritePrompt).not.toContain(
      'Any file actually modified during the task MUST be listed in `expected_files`',
    );
  });

  it('repair prompt preserves valid permission fields and fixes overlaps without widening scope', () => {
    const repairPrompt = loadPromptTemplate('plan-write', 'plan-write-repair', { promptsRoot });

    // Guidance on preserving valid declarations
    expect(repairPrompt).toMatch(/permitted_areas/);
    expect(repairPrompt).toMatch(/may_extend/);
    expect(repairPrompt).toMatch(/non_goals/);
    expect(repairPrompt).toMatch(/reference_files/);

    // Guidance on overlap resolution according to precedence without widening scope
    expect(repairPrompt).toMatch(/overlap|precedence|collision/i);
    expect(repairPrompt).toMatch(/narrowest|minimal/i);
    expect(repairPrompt).toMatch(/root/i);
  });

  it('producer prompts forbid root derivation and require explicit permission for write-capable empty tasks', () => {
    const planWritePrompt = loadPromptTemplate('plan-write', 'plan-write', { promptsRoot });

    // Root file rule
    expect(planWritePrompt).toMatch(/root/i);
    expect(planWritePrompt).toMatch(/derive|derivation|grants/i);

    // Empty task rule
    expect(planWritePrompt).toMatch(/empty/i);
    expect(planWritePrompt).toMatch(/explicit/i);
  });

  it('plan-design and plan-write prompts instruct checking existing repo tooling conventions', () => {
    const planDesignPrompt = loadPromptTemplate('plan-design', 'plan-design', { promptsRoot });
    const planWritePrompt = loadPromptTemplate('plan-write', 'plan-write', { promptsRoot });
    const repairPrompt = loadPromptTemplate('plan-write', 'plan-write-repair', { promptsRoot });

    expect(planDesignPrompt).toContain('Tooling and testing conventions');
    expect(planDesignPrompt).toMatch(/explicitly state which existing repository convention it follows/i);

    expect(planWritePrompt).toContain('TOOLING AND TEST FRAMEWORK CONVENTION GROUNDING');
    expect(planWritePrompt).toMatch(/check sibling or analogous files in the repository/i);

    expect(repairPrompt).toContain('TOOLING AND TEST FRAMEWORK CONVENTION GROUNDING');
    expect(repairPrompt).toMatch(/match their\s+established convention unless an explicit rationale is stated/i);
  });
});
