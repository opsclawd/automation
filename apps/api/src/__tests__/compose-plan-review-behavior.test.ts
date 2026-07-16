import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import {
  createComposedOrchestrationHarness,
  type ComposedOrchestrationHarness,
  createPlanReviewSemanticScript,
  createPlanReviewOrdinaryFixScript,
  createPlanReviewTerminalFixScript,
} from './helpers/composed-orchestration-harness.js';

const harnessCleanup: ComposedOrchestrationHarness[] = [];

afterEach(() => {
  for (const h of harnessCleanup) {
    h.cleanup();
  }
  harnessCleanup.length = 0;
});

function createHarness(opts: Parameters<typeof createComposedOrchestrationHarness>[0] = {}) {
  const h = createComposedOrchestrationHarness({
    repoFullName: opts.repoFullName ?? 'owner/test-repo',
    issueNumber: opts.issueNumber ?? 1,
    validationCommands: opts.validationCommands ?? ['echo ok'],
    scripts: opts.scripts,
    agentConfig: opts.agentConfig,
  });
  harnessCleanup.push(h);
  return h;
}

const VALID_DESIGN_MD = `# Test Design

This is a test design document.
`;

const VALID_PLAN_MD = `# Test Plan

## Task 1: First Task
Do the first thing.

## Task 2: Second Task
Do the second thing.
`;

const VALID_TASK_MANIFEST_V2 = JSON.stringify({
  version: 2,
  task_count: 2,
  tasks: [
    { n: 1, title: 'First Task' },
    { n: 2, title: 'Second Task' },
  ],
});

describe('compose-plan-review-behavior', () => {
  describe('terminal profile fallback', () => {
    it('plan-review terminal repair uses the arbiter profile when terminal-fix is unconfigured', async () => {
      const customAgentConfig = {
        validation: { commands: ['echo ok'], timeout: 60 },
        phases: {
          skip: [],
          planReview: { enabled: true, maxIterations: 1 },
          reviewFix: { maxIterations: 1 },
          implement: { maxIterations: 1 },
          fixValidate: { enabled: false, maxIterations: 3 },
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
        agent: {
          defaultProfile: 'test',
          profiles: {
            test: { runtime: 'opencode', provider: 'test', model: 'test', timeoutMinutes: 1 },
            'plan-review-profile': {
              runtime: 'opencode',
              provider: 'test',
              model: 'test',
              timeoutMinutes: 1,
            },
            'plan-fix-profile': {
              runtime: 'opencode',
              provider: 'test',
              model: 'test',
              timeoutMinutes: 1,
            },
            'arbiter-profile': {
              runtime: 'opencode',
              provider: 'test',
              model: 'test',
              timeoutMinutes: 1,
            },
            'result-writer': {
              runtime: 'opencode',
              provider: 'test',
              model: 'test',
              timeoutMinutes: 1,
            },
          },
          phaseProfiles: {
            'plan-review': { profile: 'plan-review-profile' },
            'plan-fix': { profile: 'plan-fix-profile' },
            arbiter: { profile: 'arbiter-profile' },
            'result-writer': { profile: 'result-writer' },
          },
        },
      };

      const findingsMd = `## verdict
p1_found

## findings
- [P1] \`plan.md:1\` | Missing transition handler | grounded | still_open
`;
      const semanticReviewScript = createPlanReviewSemanticScript(findingsMd);

      const ordinaryFixScript = createPlanReviewOrdinaryFixScript(
        (currentPlan) =>
          currentPlan +
          '\n\n## Task 3: Ordinary Fix Applied\nThis task was added by ordinary fix.\n',
        JSON.stringify({ verdict: 'done_with_fixes', summary: 'Applied fixes for P1 findings' }),
      );

      const terminalFixScript = createPlanReviewTerminalFixScript(
        (currentPlan) =>
          currentPlan +
          '\n\n## Task 3: Terminal Fix Applied\nThis task was added by terminal fix.\n',
        (currentManifest) => {
          const manifest = JSON.parse(currentManifest);
          manifest.tasks.push({ n: 3, title: 'Terminal Fix Applied' });
          manifest.task_count = manifest.tasks.length;
          return JSON.stringify(manifest);
        },
        JSON.stringify({
          verdict: 'done_with_fixes',
          summary: 'Terminal fix applied structural changes',
        }),
      );

      const harness = createHarness({
        repoFullName: 'owner/test-repo',
        issueNumber: 1,
        validationCommands: ['echo ok'],
        scripts: [semanticReviewScript, ordinaryFixScript, terminalFixScript],
        agentConfig: customAgentConfig,
      });

      const worktreeDir = path.join(harness.targetRoot, '.ai-worktrees', 'issue-1');
      mkdirSync(worktreeDir, { recursive: true });

      writeFileSync(path.join(worktreeDir, 'design.md'), VALID_DESIGN_MD);
      writeFileSync(path.join(worktreeDir, 'plan.md'), VALID_PLAN_MD);
      writeFileSync(path.join(worktreeDir, 'task-manifest.json'), VALID_TASK_MANIFEST_V2);

      await harness.context.artifacts.write({
        runId: harness.run.uuid,
        relativePath: 'design.md',
        contents: VALID_DESIGN_MD,
      });
      await harness.context.artifacts.write({
        runId: harness.run.uuid,
        relativePath: 'plan.md',
        contents: VALID_PLAN_MD,
      });
      await harness.context.artifacts.write({
        runId: harness.run.uuid,
        relativePath: 'task-manifest.json',
        contents: VALID_TASK_MANIFEST_V2,
      });

      const planReviewHandler = harness.container.phaseRegistry.get(PhaseName('plan-review'));
      expect(planReviewHandler).toBeDefined();

      await planReviewHandler!.run(harness.context);

      const scriptedInvocations = harness.scriptedInvocations;

      const ordinaryFix = scriptedInvocations.find(
        (inv) => inv.phaseId === 'plan-fix' && inv.metadata?.invocation_type !== 'terminal_fix',
      );
      const terminalFix = scriptedInvocations.find(
        (inv) => inv.phaseId === 'plan-fix' && inv.metadata?.invocation_type === 'terminal_fix',
      );

      expect(ordinaryFix).toBeDefined();
      expect(ordinaryFix!.profile).toBe(AgentProfileName('plan-fix-profile'));
      expect(ordinaryFix!.phaseId).toBe('plan-fix');

      expect(terminalFix).toBeDefined();
      expect(terminalFix!.metadata?.invocation_type).toBe('terminal_fix');
      expect(terminalFix!.profile).toBe(AgentProfileName('arbiter-profile'));
      expect(terminalFix!.phaseId).toBe('plan-fix');
      expect(terminalFix!.promptPath).toMatch(/plan-fix.*\.md/);
      expect(terminalFix!.expectedArtifacts).toEqual(['plan.md']);

      const config = JSON.parse(
        readFileSync(path.join(harness.targetRoot, '.ai-orchestrator.json'), 'utf-8'),
      );
      expect(config.agent.phaseProfiles['terminal-fix']).toBeUndefined();
    });
  });
});
