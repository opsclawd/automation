import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadPromptTemplate, renderPrompt } from '../prompts/index.js';
import { FakeArtifactStore } from '../test-doubles/fake-artifact-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const promptsRoot = resolve(__dirname, '../../../../prompts');

describe('Lean pipeline prompts (Issue #1103)', () => {
  describe('Unified Planning prompt (prompts/plan-design/plan-unified.md)', () => {
    it('loads and renders unified planning template with expected grounding and output contract', async () => {
      const template = loadPromptTemplate('plan-design', 'plan-unified', { promptsRoot });

      // Grounding & Authority
      expect(template).toMatch(/issue and comments provided above/i);
      expect(template).toMatch(/`AGENTS\.md`/);
      expect(template).toMatch(/`CONTEXT\.md`/);
      expect(template).toMatch(/relevant ADRs and design documentation/i);
      expect(template).toMatch(
        /Anchored Design, Non-goals, and Acceptance Criteria as authoritative/i,
      );

      // Output contract
      expect(template).toContain('"design_md"');
      expect(template).toContain('"plan_md"');
      expect(template).toContain('result.json');

      // Critical rules
      expect(template).toMatch(/Do not modify source files or implement the issue/i);
      expect(template).toMatch(/Do not ask questions/i);
      expect(template).toMatch(/Do not switch git branches/i);

      // Procedural reasoning choreography removed
      expect(template).not.toContain('task_manifest');
      expect(template).not.toContain('task-manifest');
      expect(template).not.toContain('expected_files');
      expect(template).not.toContain('permitted_areas');
      expect(template).not.toContain('## Task 1:');
      expect(template).not.toMatch(/RED task/i);
      expect(template).not.toMatch(/PORT\/INTERFACE CHANGES/i);
      expect(template).not.toMatch(/TEST-FIRST COMMIT ORDER/i);

      // Render verification
      const artifacts = new FakeArtifactStore();
      const rendered = await renderPrompt(template, {
        runId: 'run-test',
        vars: { issue_number: '1103', cwd: '/tmp/wt' },
        artifacts,
      });
      expect(rendered).toContain('WORKSPACE CONSTRAINTS');
      expect(rendered).toContain('result.json');
    });
  });

  describe('Lean Implementation prompt (prompts/implement/implement.md)', () => {
    it('loads and renders lean implementation template allowing justified discoveries without manifest constraints', async () => {
      const template = loadPromptTemplate('implement', 'implement', { promptsRoot });

      // Grounding & Authority
      expect(template).toContain('{{artifact?:issue.md}}');
      expect(template).toContain('{{artifact:design.md}}');
      expect(template).toContain('{{artifact:plan.md}}');
      expect(template).toMatch(/`AGENTS\.md`/);
      expect(template).toMatch(/`CONTEXT\.md`/);
      expect(template).toMatch(/GitHub issue remains authoritative/i);

      // On-the-fly implementation decisions permitted
      expect(template).toMatch(
        /Make any reasonable changes required to implement the issue correctly/i,
      );
      expect(template).toMatch(
        /helpers, callers, tests, fixtures, or adjacent code that the plan did not anticipate/i,
      );

      // Anti-scope-creep & architectural boundary rules
      expect(template).toMatch(/Avoid unrelated cleanup or refactoring/i);
      expect(template).toMatch(/Follow repository architecture and engineering conventions/i);

      // Output contract
      expect(template).toContain('implementation-log.md');
      expect(template).toContain('Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT');

      // Removal of manifest/file whitelist constraints
      expect(template).not.toContain('task_manifest');
      expect(template).not.toContain('task-manifest');
      expect(template).not.toContain('manifest-declared');

      // Render verification
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'run-test',
        relativePath: 'issue.md',
        contents: '# Issue 1103',
      });
      await artifacts.write({ runId: 'run-test', relativePath: 'design.md', contents: '# Design' });
      await artifacts.write({ runId: 'run-test', relativePath: 'plan.md', contents: '# Plan' });

      const rendered = await renderPrompt(template, {
        runId: 'run-test',
        vars: { issue_number: '1103', cwd: '/tmp/wt' },
        artifacts,
      });
      expect(rendered).toContain('# Issue 1103');
      expect(rendered).toContain('# Design');
      expect(rendered).toContain('# Plan');
      expect(rendered).toContain('implementation-log.md');
    });
  });

  describe('Whole-Change Review prompt (prompts/review-fix/whole-change-review.md)', () => {
    it('loads and renders whole-change review template with AC verification and material findings focus', async () => {
      const template = loadPromptTemplate('review-fix', 'whole-change-review', { promptsRoot });

      // Grounding & Read-only
      expect(template).toMatch(/read-only review/i);
      expect(template).toContain('{{var:complete_diff}}');
      expect(template).toContain('{{var:validation_evidence}}');
      expect(template).toContain('{{artifact?:issue.md}}');
      expect(template).toContain('{{artifact:design.md}}');
      expect(template).toContain('{{artifact:plan.md}}');

      // Production-artifact fidelity & supported success path (#1118)
      expect(template).toMatch(/Production-Artifact Fidelity & Environment Grounding/i);
      expect(template).toMatch(
        /inspect the authoritative production artifact rather than relying solely on code abstractions or synthetic fixtures/i,
      );
      expect(template).toMatch(
        /Determine which artifact is authoritative from the repository itself/i,
      );
      expect(template).toMatch(
        /Synthetic, unit, or integration fixtures support correctness evaluation but cannot by themselves prove correctness/i,
      );
      expect(template).toMatch(/Supported Success-Path Verification/i);
      expect(template).toMatch(
        /Verify that at least one valid end-to-end success path exists under the actual supported production configuration/i,
      );
      expect(template).toMatch(/converts? one failure into an unavoidable downstream failure/i);
      expect(template).toMatch(
        /consistency among declared capabilities, validation rules, runtime behavior, and output\/provenance contracts/i,
      );

      // Generic durable wording without target-repo specifics
      expect(template).not.toMatch(/audioPrompt/i);
      expect(template).not.toMatch(/\bLTX\b/);
      expect(template).not.toMatch(/ComfyUI/i);
      expect(template).not.toMatch(/RenderProfile/i);

      // Material findings focus & AC verification
      expect(template).toMatch(/Look for material problems including/i);
      expect(template).toMatch(
        /Explicitly verify every Acceptance Criterion from the issue as PASS or FAIL/i,
      );
      expect(template).toMatch(/`APPROVE` if no merge-blocking defects remain/i);
      expect(template).toMatch(/`REQUEST_CHANGES` if correction is required/i);

      // Schema output
      expect(template).toContain('result.json');
      expect(template).toContain('"verdict"');
      expect(template).toContain('"acceptance_criteria"');
      expect(template).toContain('"findings"');

      // No manifest dependencies or redundant severity taxonomy prose
      expect(template).not.toContain('task_manifest');
      expect(template).not.toContain('task-manifest');
      expect(template).not.toMatch(/"critical": Security vulnerabilities/);

      // Render verification
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'run-test',
        relativePath: 'issue.md',
        contents: '# Issue 1103',
      });
      await artifacts.write({ runId: 'run-test', relativePath: 'design.md', contents: '# Design' });
      await artifacts.write({ runId: 'run-test', relativePath: 'plan.md', contents: '# Plan' });

      const rendered = await renderPrompt(template, {
        runId: 'run-test',
        vars: {
          issue_number: '1103',
          cwd: '/tmp/wt',
          complete_diff: 'diff --git a/test.ts b/test.ts',
          validation_evidence: 'All 10 tests passed',
        },
        artifacts,
      });
      expect(rendered).toContain('diff --git a/test.ts b/test.ts');
      expect(rendered).toContain('All 10 tests passed');
      expect(rendered).toContain('Production-Artifact Fidelity');
    });
  });

  describe('Spec Review prompt (prompts/review-fix/spec-review.md)', () => {
    it('loads and renders spec review template with requirements ledger, hard gates and falsification guidance', async () => {
      const template = loadPromptTemplate('review-fix', 'spec-review', { promptsRoot });

      // Grounding & Read-only
      expect(template).toMatch(/read-only review/i);
      expect(template).toContain('{{var:complete_diff}}');
      expect(template).toContain('{{var:validation_evidence}}');
      expect(template).toContain('{{var:requirements_ledger}}');
      expect(template).toContain('{{artifact:design.md}}');

      // Hard gates and falsification
      expect(template).toMatch(/Hard Gates & Adversarial Falsification/i);
      expect(template).toMatch(/falsify/i);
      expect(template).toMatch(/hash mismatch prevents FFmpeg dispatch/i);
      expect(template).toMatch(/counterexample_considered/i);

      // Output contract
      expect(template).toContain('result.json');
      expect(template).toContain('"verdict"');
      expect(template).toContain('"requirements_checks"');

      // Render verification
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'run-test',
        relativePath: 'issue.md',
        contents: '# Issue 1132',
      });
      await artifacts.write({ runId: 'run-test', relativePath: 'design.md', contents: '# Design' });
      await artifacts.write({ runId: 'run-test', relativePath: 'plan.md', contents: '# Plan' });

      const rendered = await renderPrompt(template, {
        runId: 'run-test',
        vars: {
          issue_number: '1132',
          cwd: '/tmp/wt',
          complete_diff: 'diff --git a/app.ts b/app.ts',
          validation_evidence: 'All tests passed',
          requirements_ledger: '- [AC-1] Check hash',
          orchestrator_bookkeeping_files: '- `review-head-sha.txt`',
        },
        artifacts,
      });
      expect(rendered).toContain('diff --git a/app.ts b/app.ts');
      expect(rendered).toContain('- [AC-1] Check hash');
      expect(rendered).toContain('review-head-sha.txt');
      expect(rendered).toContain('Hard Gates & Adversarial Falsification');
    });
  });

  describe('Quality Review prompt (prompts/review-fix/quality-review.md)', () => {
    it('loads and renders quality review template with architecture, layer boundaries, and quality checklist', async () => {
      const template = loadPromptTemplate('review-fix', 'quality-review', { promptsRoot });

      // Grounding & Read-only
      expect(template).toMatch(/read-only review/i);
      expect(template).toContain('{{var:complete_diff}}');
      expect(template).toContain('{{var:validation_evidence}}');
      expect(template).toContain('{{var:spec_review_summary}}');

      // Architecture & Layer Boundaries
      expect(template).toMatch(/Architecture & Layer Boundaries/i);
      expect(template).toMatch(/`AGENTS\.md`/);
      expect(template).toMatch(/packages\/application/);

      // Scope distinction
      expect(template).toMatch(/Do (?:\*\*|)?not(?:\*\*|)? duplicate the spec review/i);

      // Output contract
      expect(template).toContain('result.json');
      expect(template).toContain('"verdict"');
      expect(template).toContain('"findings"');

      // Render verification
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'run-test',
        relativePath: 'issue.md',
        contents: '# Issue 1132',
      });
      await artifacts.write({ runId: 'run-test', relativePath: 'design.md', contents: '# Design' });
      await artifacts.write({ runId: 'run-test', relativePath: 'plan.md', contents: '# Plan' });

      const rendered = await renderPrompt(template, {
        runId: 'run-test',
        vars: {
          issue_number: '1132',
          cwd: '/tmp/wt',
          complete_diff: 'diff --git a/app.ts b/app.ts',
          validation_evidence: 'All tests passed',
          spec_review_summary: 'Spec review passed all checks',
          orchestrator_bookkeeping_files: '- `review-head-sha.txt`',
        },
        artifacts,
      });
      expect(rendered).toContain('diff --git a/app.ts b/app.ts');
      expect(rendered).toContain('Spec review passed all checks');
      expect(rendered).toContain('Architecture & Layer Boundaries');
    });
  });

  describe('Follow-up Review prompt (prompts/review-fix/follow-up-review.md)', () => {
    it('loads and renders follow-up review template with causal-chain and production-artifact verification', async () => {
      const template = loadPromptTemplate('review-fix', 'follow-up-review', { promptsRoot });

      // Grounding & Read-only
      expect(template).toMatch(/read-only review/i);
      expect(template).toContain('{{var:finding_ledger}}');
      expect(template).toContain('{{var:complete_diff}}');
      expect(template).toContain('{{var:fix_diff}}');
      expect(template).toContain('{{var:validation_evidence}}');

      // Causal-chain requirements (#1117)
      expect(template).toMatch(
        /Independently trace the finding's full causal chain — from the root symptom described in its `rationale` through to the actual runtime behavior/i,
      );
      expect(template).toMatch(
        /Cite the exact file\/line\(s\) that establish the full chain is closed/i,
      );

      // Production-artifact fidelity & supported success path (#1118)
      expect(template).toMatch(
        /trace that finding through any authoritative production artifacts/i,
      );
      expect(template).toMatch(
        /Inspect only the production artifacts materially required by those causal chains to keep the follow-up review focused/i,
      );
      expect(template).toMatch(
        /Synthetic tests or constructed fixtures are supporting evidence only and cannot establish resolution/i,
      );
      expect(template).toMatch(
        /converts? one failure into an unavoidable downstream failure, leaving the supported production configuration internally unsatisfiable/i,
      );
      expect(template).toMatch(
        /at least one valid end-to-end success path exists under the actual supported production configuration/i,
      );
      expect(template).toMatch(
        /consistency among declared capabilities, validation rules, runtime behavior, and output\/provenance contracts/i,
      );

      // Finding-centered scope constraint (does not turn into unrestricted whole-change review)
      expect(template).toMatch(
        /Do not turn follow-up review into an unrestricted second whole-change review/i,
      );

      // Generic durable wording without target-repo specifics
      expect(template).not.toMatch(/audioPrompt/i);
      expect(template).not.toMatch(/\bLTX\b/);
      expect(template).not.toMatch(/ComfyUI/i);
      expect(template).not.toMatch(/RenderProfile/i);

      // Schema output
      expect(template).toContain('result.json');
      expect(template).toContain('"verdict"');
      expect(template).toContain('"evaluations"');
      expect(template).toContain('"new_findings"');

      // Render verification
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'run-test',
        relativePath: 'issue.md',
        contents: '# Issue 1118',
      });
      await artifacts.write({ runId: 'run-test', relativePath: 'design.md', contents: '# Design' });
      await artifacts.write({ runId: 'run-test', relativePath: 'plan.md', contents: '# Plan' });

      const rendered = await renderPrompt(template, {
        runId: 'run-test',
        vars: {
          issue_number: '1118',
          cwd: '/tmp/wt',
          finding_ledger: '1. Finding A (unresolved)',
          complete_diff: 'diff --git a/app.ts b/app.ts',
          fix_diff: 'diff --git a/app.ts b/app.ts (fix)',
          validation_evidence: 'All tests passed',
          orchestrator_bookkeeping_files: '- `review-head-sha.txt`',
        },
        artifacts,
      });
      expect(rendered).toContain('1. Finding A (unresolved)');
      expect(rendered).toContain('diff --git a/app.ts b/app.ts (fix)');
      expect(rendered).toContain('review-head-sha.txt');
    });
  });

  describe('Targeted Fix prompt (prompts/review-fix/targeted-fix.md)', () => {
    it('loads and renders targeted fix template without git staging/commit choreography', async () => {
      const template = loadPromptTemplate('review-fix', 'targeted-fix', { promptsRoot });

      // Grounding
      expect(template).toContain('{{var:review_findings}}');
      expect(template).toContain('{{artifact?:issue.md}}');
      expect(template).toContain('{{artifact:design.md}}');
      expect(template).toContain('{{artifact:plan.md}}');

      // Scope & Worktree State
      expect(template).toMatch(/Fix ONLY what the review findings report/i);
      expect(template).toMatch(
        /leave the worktree in a finished state for deterministic validation/i,
      );

      // Output contract
      expect(template).toContain('result.json');
      expect(template).toContain('"result": "done_with_fixes"');

      // Critical rules & No git staging/commit choreography
      expect(template).not.toMatch(/git add/i);
      expect(template).not.toMatch(/git commit/i);
      expect(template).toMatch(/Do not create commits/i);
      expect(template).toMatch(/Do not switch git branches/i);
      expect(template).toMatch(/Do not ask questions/i);

      // Render verification
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'run-test',
        relativePath: 'issue.md',
        contents: '# Issue 1103',
      });
      await artifacts.write({ runId: 'run-test', relativePath: 'design.md', contents: '# Design' });
      await artifacts.write({ runId: 'run-test', relativePath: 'plan.md', contents: '# Plan' });

      const rendered = await renderPrompt(template, {
        runId: 'run-test',
        vars: {
          issue_number: '1103',
          cwd: '/tmp/wt',
          review_findings: '1. Broken null check in foo.ts',
        },
        artifacts,
      });
      expect(rendered).toContain('1. Broken null check in foo.ts');
      expect(rendered).toContain('done_with_fixes');
    });
  });
});
