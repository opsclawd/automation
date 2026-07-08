import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveArchitectProfileName } from '../architect-profile.js';
import { buildArchitectPrompt } from '../architect-prompt.js';

describe('compose runArchitect wiring', () => {
  it('exports architectPlanSchema from @ai-sdlc/application', async () => {
    const mod = await import('@ai-sdlc/application');
    expect(typeof (mod as Record<string, unknown>).architectPlanSchema).toBe('object');
  });

  it('does NOT add fix-review-architect to PHASE_RESULT_REGISTRY (D5: step-internal artefact)', async () => {
    const mod = await import('@ai-sdlc/application');
    const reg = (mod as Record<string, unknown>).PHASE_RESULT_REGISTRY as Record<
      string,
      { retrySafe: boolean }
    >;
    expect(reg['fix-review-architect']).toBeUndefined();
  });

  it('buildArchitectPrompt writes a read-only prompt ending with the STOP RULE', () => {
    const prompt = buildArchitectPrompt(
      { cwd: '/tmp', repoId: 'r' },
      { manifest: '{"tasks":[]}', reviewMd: '', triageMd: '' },
    );
    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toMatch(/STOP RULE/);
  });

  it('architect profile name resolution: dedicated key wins over planner', () => {
    expect(
      resolveArchitectProfileName(
        { 'fix-review-architect': { profile: 'a' } },
        { planner: { profile: 'b' } },
      ),
    ).toBe('a');
  });

  it('compose.ts wires resolveArchitectProfileName and dispatches architect under fix-review-architect phaseId', async () => {
    const src = readFileSync(path.join(import.meta.dirname ?? __dirname, '../compose.ts'), 'utf-8');
    expect(src).toContain('resolveArchitectProfileName(');
    expect(src).toContain("phaseId: 'fix-review-architect'");
  });

  it('compose.ts invokes maybeRunArchitect inside ReviewFixHandler.runLoop', async () => {
    const src = readFileSync(path.join(import.meta.dirname ?? __dirname, '../compose.ts'), 'utf-8');
    // The new architect invocation must be inside the ReviewFixHandler.runLoop
    // closure (D1: closure, not new port), and the result must be threaded
    // into reviewFixLoopInstance.execute as `architectPlan`.
    expect(src).toContain('maybeRunArchitect(');
    expect(src).toMatch(/architectPlan\s*\?\s*\{\s*architectPlan\s*\}\s*:\s*\{\}/);
  });

  it('architect plan Zod schema rejects a plan with empty tasks array', async () => {
    // Defense-in-depth check (D2: the handler-side validator is
    // required in addition to the CLI parser so a direct API call
    // cannot bypass the schema).
    const mod = (await import('@ai-sdlc/application')) as unknown as {
      architectPlanSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const result = mod.architectPlanSchema.safeParse({ version: 1, tasks: [] });
    expect(result.success).toBe(false);
  });

  it('architect plan Zod schema accepts the legacy jq-validated shape', async () => {
    const mod = (await import('@ai-sdlc/application')) as unknown as {
      architectPlanSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const result = mod.architectPlanSchema.safeParse({
      version: 1,
      tasks: [
        {
          task_id: 'C1',
          approach: 'Check before loop',
          conflicts_resolved: ['CONF-005'],
          constraints: ['Must not use for-in with set -u'],
          depends_on: [],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('compose.ts respects failed architect invocation outcomes', async () => {
    const src = readFileSync(path.join(import.meta.dirname ?? __dirname, '../compose.ts'), 'utf-8');
    expect(src).toContain('agentOutcome = result.outcome');
  });
});
