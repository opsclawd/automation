import { describe, it, expect, vi } from 'vitest';
import { AgentProfileName } from '@ai-sdlc/domain';
import { SpecReviewHandler } from '../spec-review.js';
import {
  FakeArtifactStore,
  FakeGitPort,
  FakeAgentPort,
  FakeGitHubPort,
} from '../../../test-doubles/index.js';
import type { PhaseHandlerContext } from '../../handler.js';
import { recordValidationEvidence } from '../../validation-evidence.js';

const { mockLoadPromptTemplate, mockRenderPrompt } = vi.hoisted(() => ({
  mockLoadPromptTemplate: vi.fn(() => '# Spec Review Template\n'),
  mockRenderPrompt: vi.fn(async () => '# Rendered Prompt\n'),
}));

vi.mock('../../../prompts/load-prompt-template.js', () => ({
  loadPromptTemplate: mockLoadPromptTemplate,
}));

vi.mock('../../../prompts/render-prompt.js', () => ({
  renderPrompt: mockRenderPrompt,
}));

describe('SpecReviewHandler', () => {
  const setup = () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const agent = new FakeAgentPort();
    const events = { publish: vi.fn() };

    git.headByCwd.set('/tmp/worktree', 'commit-sha-1132');
    git.currentBranchByCwd.set('/tmp/worktree', 'ai/issue-1132');

    const ctx: PhaseHandlerContext = {
      runId: 'run-1132',
      runUuid: 'run-1132',
      issueNumber: 1132,
      repoFullName: 'owner/repo',
      cwd: '/tmp/worktree',
      executionPolicy: 'standard',
      promptsRoot: '/tmp',
      automationRoot: '/tmp/repo',
      targetRoot: '/tmp/repo',
      startCommitSha: 'commit-sha-1132',
      expectedBranch: 'ai/issue-1132',
      artifacts,
      git,
      agent,
      events,
      now: () => new Date('2026-08-31T00:00:00Z'),
      idFactory: () => 'inv-1',
      resolveProfile: (phase: string) =>
        phase === 'post-implementation-spec-review' || phase === 'spec-review'
          ? AgentProfileName('spec-review')
          : AgentProfileName(phase),
    };

    const handler = new SpecReviewHandler();

    return { ctx, artifacts, git, agent, events, handler };
  };

  it('fails with missing_artifact when issue.md or design.md is missing', async () => {
    const { ctx, handler } = setup();

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('missing_artifact');
    }
  });

  it('fails with validation_failed when deterministic validation evidence is missing or stale', async () => {
    const { ctx, artifacts, handler } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1132\n## Acceptance Criteria\n- [ ] Must preflight capabilities',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1132',
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('validation_failed');
    }
  });

  it('executes spec review and approves when all requirements pass', async () => {
    const { ctx, artifacts, git, agent, handler } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1132\n## Acceptance Criteria\n- [ ] Must preflight capabilities',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1132',
    });

    await recordValidationEvidence(ctx, 'validate');

    // Simulate orchestrator bookkeeping already sitting untracked in the
    // worktree.
    git.statusByCwd.set(
      '/tmp/worktree',
      ['?? review-head-sha.txt', '?? spec-review-head-sha.txt'].join('\n'),
    );

    agent.enqueue('spec-review', async () => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'PASS',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Must preflight capabilities',
              result: 'PASS',
              evidence: 'Checked preflight capability checks in ffmpeg service',
              test_evidence: 'Preflight unit test passes',
              counterexample_considered: 'Tested missing filter capability error path',
            },
          ],
          findings: [],
          summary: 'All requirements satisfied',
        }),
      });
      return {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        resultJsonPath: 'result.json',
        contractViolations: [],
        outcome: 'success',
      };
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('passed');

    // Artifacts persisted
    const specJson = await artifacts.read(ctx.runUuid, 'spec-review.json');
    expect(JSON.parse(specJson).verdict).toBe('PASS');

    const specMd = await artifacts.read(ctx.runUuid, 'spec-review.md');
    expect(specMd).toContain('# Spec Review');
    expect(specMd).toContain('Must preflight capabilities');

    const codeReviewMd = await artifacts.read(ctx.runUuid, 'code-review.md');
    expect(codeReviewMd).toContain('# Spec Review');

    const ledgerRaw = await artifacts.read(ctx.runUuid, 'finding-ledger.json');
    const ledger = JSON.parse(ledgerRaw);
    expect(ledger.entries).toHaveLength(0);

    const headSha = await artifacts.read(ctx.runUuid, 'review-head-sha.txt');
    expect(headSha.trim()).toBe('commit-sha-1132');

    // The reviewer is given the exact orchestrator-owned untracked paths
    // currently in the worktree, so it doesn't independently discover them
    // via `git status` and flag them as scratch-artifact/hygiene findings.
    const renderCall = mockRenderPrompt.mock.calls.at(-1)?.[1] as { vars: Record<string, string> };
    const bookkeepingVar = renderCall.vars.orchestrator_bookkeeping_files;
    expect(bookkeepingVar).toContain('`review-head-sha.txt`');
    expect(bookkeepingVar).toContain('`spec-review-head-sha.txt`');
  });

  it('records failing requirements in finding-ledger when spec review requests changes', async () => {
    const { ctx, artifacts, agent, handler } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1132\n## Acceptance Criteria\n- [ ] Must preflight capabilities',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1132',
    });

    await recordValidationEvidence(ctx, 'validate');

    agent.enqueue('spec-review', async () => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'FAIL',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Must preflight capabilities',
              result: 'FAIL',
              evidence: 'Capabilities not preflighted before dispatch',
              test_evidence: 'Missing test',
              counterexample_considered: 'Missing capability crashes FFmpeg downstream',
            },
          ],
          findings: [
            {
              severity: 'high',
              files: ['src/ffmpeg.ts'],
              evidence: 'No preflight call',
              rationale: 'FFmpeg fails downstream on missing filter',
              minimal_correction: 'Add preflight check',
              blocking: true,
            },
          ],
          summary: 'Preflight requirement failed',
        }),
      });
      return {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        resultJsonPath: 'result.json',
        contractViolations: [],
        outcome: 'success',
      };
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('passed');

    const specJson = await artifacts.read(ctx.runUuid, 'spec-review.json');
    expect(JSON.parse(specJson).verdict).toBe('FAIL');

    const ledgerRaw = await artifacts.read(ctx.runUuid, 'finding-ledger.json');
    const ledger = JSON.parse(ledgerRaw);
    expect(ledger.entries.length).toBeGreaterThanOrEqual(1);
    expect(ledger.entries[0].source).toBe('spec-review');
  });

  it('resumes with approval reuse when recorded review-head-sha matches current HEAD', async () => {
    const { ctx, artifacts, handler } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'spec-review.json',
      contents: JSON.stringify({
        verdict: 'PASS',
        requirements_checks: [
          {
            requirement_id: 'AC-1',
            requirement: 'Must preflight capabilities',
            result: 'PASS',
            evidence: 'Checked',
            counterexample_considered: 'Tested missing',
          },
        ],
        findings: [],
      }),
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'spec-requirements-ledger.json',
      contents: JSON.stringify({
        version: 1,
        issueNumber: 1132,
        items: [
          {
            id: 'AC-1',
            category: 'acceptance_criteria',
            title: 'Must preflight capabilities',
            source: 'issue.md',
            hardGate: true,
          },
        ],
      }),
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'review-head-sha.txt',
      contents: 'commit-sha-1132\n',
    });
    await recordValidationEvidence(ctx, 'validate');

    // Agent should NOT be invoked
    const res = await handler.run(ctx);
    expect(res.outcome).toBe('passed');
  });

  it('does NOT reuse review approval if deterministic validation is missing or stale on resume', async () => {
    const { ctx, artifacts, handler } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'spec-review.json',
      contents: JSON.stringify({
        verdict: 'PASS',
        requirements_checks: [
          {
            requirement_id: 'AC-1',
            requirement: 'Must preflight capabilities',
            result: 'PASS',
            evidence: 'Checked',
            counterexample_considered: 'Tested missing',
          },
        ],
        findings: [],
      }),
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'spec-requirements-ledger.json',
      contents: JSON.stringify({
        version: 1,
        issueNumber: 1132,
        items: [
          {
            id: 'AC-1',
            category: 'acceptance_criteria',
            title: 'Must preflight capabilities',
            source: 'issue.md',
            hardGate: true,
          },
        ],
      }),
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'review-head-sha.txt',
      contents: 'commit-sha-1132\n',
    });

    // Validation evidence is NOT recorded / invalid
    // Execution falls through to required inputs check and fails validation_failed
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1132',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1132',
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('validation_failed');
    }
  });

  it('does NOT reuse review approval if worktree HEAD has changed since approval (stale approval)', async () => {
    const { ctx, artifacts, agent, handler, git } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1132\n## Acceptance Criteria\n- [ ] Must preflight capabilities',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1132',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'spec-review.json',
      contents: JSON.stringify({
        verdict: 'PASS',
        requirements_checks: [
          {
            requirement_id: 'AC-1',
            requirement: 'Must preflight capabilities',
            result: 'PASS',
            evidence: 'Checked',
            counterexample_considered: 'Tested missing',
          },
        ],
        findings: [],
      }),
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'review-head-sha.txt',
      contents: 'old-stale-sha\n',
    });

    // Current HEAD is different
    git.headByCwd.set('/tmp/worktree', 'new-commit-sha');
    ctx.startCommitSha = 'new-commit-sha';
    await recordValidationEvidence(ctx, 'validate');

    agent.enqueue('spec-review', async () => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'PASS',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Must preflight capabilities',
              result: 'PASS',
              evidence: 'Re-verified against new HEAD',
              counterexample_considered: 'Tested adversarial on new commit',
            },
          ],
          findings: [],
        }),
      });
      return {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        resultJsonPath: 'result.json',
        contractViolations: [],
        outcome: 'success',
      };
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('passed');
    // Fresh SHA should now be persisted
    const headSha = await artifacts.read(ctx.runUuid, 'review-head-sha.txt');
    expect(headSha.trim()).toBe('new-commit-sha');
  });

  it('injects validation_critical_files into prompt vars when validate/critical-files.json is present', async () => {
    const { ctx, artifacts, agent, handler } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1150',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1150',
    });
    await recordValidationEvidence(ctx, 'validate');

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'validate/critical-files.json',
      contents: JSON.stringify([
        {
          path: 'packages/api/src/whisperx.ts',
          beforeHash: 'hash-1',
          afterHash: 'hash-2',
          diagnostic: 'pnpm test:whisperx timed out',
        },
      ]),
    });

    agent.enqueue('spec-review', async () => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'PASS',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Requirement 1',
              result: 'PASS',
              evidence: 'Satisfied',
            },
          ],
          findings: [],
          summary: 'Approved',
        }),
      });
      return {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        resultJsonPath: 'result.json',
        contractViolations: [],
        outcome: 'success',
      };
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('passed');

    expect(mockRenderPrompt).toHaveBeenCalled();
    const lastCall = mockRenderPrompt.mock.calls[mockRenderPrompt.mock.calls.length - 1];
    const promptCtx = lastCall?.[1];
    expect(promptCtx?.vars.validation_critical_files).toContain('packages/api/src/whisperx.ts');
    expect(promptCtx?.vars.validation_critical_files).toContain('pnpm test:whisperx timed out');
  });

  it('handles APPROVE verdict alias and normalizes to PASS (issue #1222 audit)', async () => {
    const { ctx, artifacts, agent, handler, events } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1132\n## Acceptance Criteria\n- [ ] Must preflight capabilities',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1132',
    });
    await recordValidationEvidence(ctx, 'validate');

    agent.enqueue('spec-review', async () => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'APPROVE',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Must preflight capabilities',
              result: 'PASS',
              evidence: 'Satisfied',
              counterexample_considered: 'Tested adversarial failure path',
            },
          ],
          findings: [],
          summary: 'All requirements pass',
        }),
      });
      return {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        resultJsonPath: 'result.json',
        contractViolations: [],
        outcome: 'success',
      };
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('passed');

    const specJson = await artifacts.read(ctx.runUuid, 'spec-review.json');
    expect(JSON.parse(specJson).verdict).toBe('PASS');

    expect(events.publish).toHaveBeenCalledWith(
      'run-1132',
      expect.objectContaining({
        type: 'spec_review.completed',
        metadata: expect.objectContaining({
          verdict: 'PASS',
        }),
      }),
    );
  });

  it('omits exit-gate criteria and traceability matrix from spec-requirements-ledger.json and approves cleanly', async () => {
    const { ctx, artifacts, agent, handler } = setup();
    const github = new FakeGitHubPort();
    ctx.github = github;

    github.issues.set('owner/repo/69', {
      number: 69,
      title: 'Phase 3 exit-gate and candidate validation',
      body: `
# Issue 69: Exit Gate
Depends on #1132

## Acceptance criteria
- [ ] Timeline assembly interface supported
- [ ] Real-provider candidate validation is run against a locked SHA with pinned model identity.
- [ ] Candidate receives an explicit evidence-backed **GO** before Phase 3 is considered complete.
- [ ] Validation harness CLI accepts candidate SHA flag.
`,
      labels: [],
    });

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: `# Issue 1132: Base Timeline Assembly\nDirect consumer: #69\n\n## Acceptance criteria\n- [ ] Implement base timeline interface\n`,
    });

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: `
# Design: Base Timeline Assembly

## Anchored Design
- Unified timeline interface

## 6.1 Complete Requirements Traceability Matrix
- Must provide verification evidence for CONSUMER-69-AC-9
- Must provide verification evidence for CONSUMER-69-AC-10
`,
    });

    await recordValidationEvidence(ctx, 'validate');

    agent.enqueue('spec-review', async () => {
      // Read generated spec-requirements-ledger.json to verify it has been filtered
      const ledgerRaw = await artifacts.read(ctx.runUuid, 'spec-requirements-ledger.json');
      const ledger = JSON.parse(ledgerRaw) as { items: Array<{ id: string; title: string }> };

      expect(ledger.items.some((it) => it.id === 'AC-1')).toBe(true);
      expect(ledger.items.some((it) => it.id === 'CONSUMER-69-AC-1')).toBe(true);
      expect(ledger.items.some((it) => it.id === 'CONSUMER-69-AC-4')).toBe(true);
      // Exit gate criteria must not be present
      expect(ledger.items.some((it) => it.id === 'CONSUMER-69-AC-2')).toBe(false);
      expect(ledger.items.some((it) => it.id === 'CONSUMER-69-AC-3')).toBe(false);
      // Traceability matrix must not be present as an anchored design requirement
      expect(
        ledger.items.some(
          (it) => it.title.includes('Traceability Matrix') || it.title.includes('CONSUMER-69-AC-9'),
        ),
      ).toBe(false);

      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'APPROVE',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Implement base timeline interface',
              result: 'PASS',
              evidence: 'Implemented in timeline.ts',
            },
            {
              requirement_id: 'DESIGN-1',
              requirement: 'Unified timeline interface',
              result: 'PASS',
              evidence: 'Implemented interface',
            },
            {
              requirement_id: 'CONSUMER-69-AC-1',
              requirement: 'Timeline assembly interface supported',
              result: 'PASS',
              evidence: 'Supported by timeline interface',
            },
            {
              requirement_id: 'CONSUMER-69-AC-4',
              requirement: 'Validation harness CLI accepts candidate SHA flag.',
              result: 'PASS',
              evidence: 'Flag supported in options',
            },
          ],
          findings: [],
          summary: 'All requirements pass',
        }),
      });
      return {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        resultJsonPath: 'result.json',
        contractViolations: [],
        outcome: 'success',
      };
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('passed');
  });

  it('passes live worktree configuration to spec-review prompt and recognizes implement-time validation commands (issue #1270)', async () => {
    const { ctx, artifacts, agent, handler } = setup();

    const readWorktreeFileMock = vi
      .fn()
      .mockImplementation(async (cwd: string, relativePath: string) => {
        if (cwd === '/tmp/worktree' && relativePath === '.ai-orchestrator.json') {
          return JSON.stringify(
            {
              validation: {
                commands: ['exit-gate:phase1', 'exit-gate:phase2', 'test:browser'],
              },
            },
            null,
            2,
          );
        }
        return undefined;
      });
    ctx.readWorktreeFile = readWorktreeFileMock;

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: `# Issue 1270
## Acceptance Criteria
- [ ] AC-1: Implement core functionality
- [ ] AC-2: Add tests for validation config
- [ ] AC-3: validation.commands includes exit-gate:phase1, exit-gate:phase2, and test:browser
`,
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1270',
    });

    await recordValidationEvidence(ctx, 'validate');

    agent.enqueue('spec-review', async () => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'PASS',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Implement core functionality',
              result: 'PASS',
              evidence: 'Implemented in core.ts',
            },
            {
              requirement_id: 'AC-2',
              requirement: 'Add tests for validation config',
              result: 'PASS',
              evidence: 'Tests added in test file',
            },
            {
              requirement_id: 'AC-3',
              requirement:
                'validation.commands includes exit-gate:phase1, exit-gate:phase2, and test:browser',
              result: 'PASS',
              evidence:
                'Verified .ai-orchestrator.json in live worktree contains exit-gate:phase1, exit-gate:phase2, and test:browser',
            },
          ],
          findings: [],
          summary: 'All requirements verified including live worktree validation commands',
        }),
      });
      return {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        resultJsonPath: 'result.json',
        contractViolations: [],
        outcome: 'success',
      };
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('passed');

    expect(readWorktreeFileMock).toHaveBeenCalledWith('/tmp/worktree', '.ai-orchestrator.json');

    expect(mockRenderPrompt).toHaveBeenCalled();
    const lastCall = mockRenderPrompt.mock.calls[mockRenderPrompt.mock.calls.length - 1];
    const promptCtx = lastCall?.[1];
    expect(promptCtx?.vars.live_worktree_configuration).toContain('exit-gate:phase1');
    expect(promptCtx?.vars.live_worktree_configuration).toContain('exit-gate:phase2');
    expect(promptCtx?.vars.live_worktree_configuration).toContain('test:browser');
    expect(promptCtx?.vars.live_worktree_configuration).toContain('Status: present');

    const specJson = await artifacts.read(ctx.runUuid, 'spec-review.json');
    const parsed = JSON.parse(specJson);
    expect(parsed.verdict).toBe('PASS');
    expect(parsed.findings).toEqual([]);
    const ledgerRaw = await artifacts.read(ctx.runUuid, 'finding-ledger.json');
    const ledger = JSON.parse(ledgerRaw);
    expect(ledger.entries).toHaveLength(0);
  });

  it('provides explicit unavailable state when worktree config is missing or unreadable, and fails closed without silent approval (issue #1270)', async () => {
    const { ctx, artifacts, agent, handler } = setup();

    const readWorktreeFileMock = vi.fn().mockResolvedValue(undefined);
    ctx.readWorktreeFile = readWorktreeFileMock;

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: `# Issue 1270\n## Acceptance Criteria\n- [ ] AC-1: Configure exit-gate in .ai-orchestrator.json`,
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1270',
    });

    await recordValidationEvidence(ctx, 'validate');

    agent.enqueue('spec-review', async () => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'FAIL',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Configure exit-gate in .ai-orchestrator.json',
              result: 'FAIL',
              evidence: '.ai-orchestrator.json is missing in live worktree',
            },
          ],
          findings: [
            {
              severity: 'critical',
              files: ['.ai-orchestrator.json'],
              evidence: 'Configuration file missing',
              rationale: 'Required configuration was not found in worktree',
              minimal_correction: 'Add .ai-orchestrator.json',
              blocking: true,
            },
          ],
          summary: 'Missing configuration',
        }),
      });
      return {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        resultJsonPath: 'result.json',
        contractViolations: [],
        outcome: 'success',
      };
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('passed');

    expect(readWorktreeFileMock).toHaveBeenCalledWith('/tmp/worktree', '.ai-orchestrator.json');
    const lastCall = mockRenderPrompt.mock.calls[mockRenderPrompt.mock.calls.length - 1];
    const promptCtx = lastCall?.[1];
    expect(promptCtx?.vars.live_worktree_configuration).toContain('Status: NOT PRESENT');

    const specJson = await artifacts.read(ctx.runUuid, 'spec-review.json');
    const parsed = JSON.parse(specJson);
    expect(parsed.verdict).toBe('FAIL');
    const ledgerRaw = await artifacts.read(ctx.runUuid, 'finding-ledger.json');
    const ledger = JSON.parse(ledgerRaw);
    expect(ledger.entries.length).toBeGreaterThanOrEqual(1);
    expect(ledger.entries[0].evidence).toContain('.ai-orchestrator.json is missing');
  });

  it('recognizes validation commands supplied across inherited automation and local layers without false-positive missing command findings (findings F-28453ee5, F-9372c900, AC-2, AC-3)', async () => {
    const { ctx, artifacts, agent, handler } = setup();

    ctx.automationRoot = '/tmp/automation';
    ctx.targetRoot = '/tmp/repo';
    ctx.cwd = '/tmp/worktree';

    const automationBase = JSON.stringify({
      validation: {
        commands: ['exit-gate:phase1', 'exit-gate:phase2'],
      },
    });
    const targetBase = JSON.stringify({
      validation: {
        additionalCommands: ['test:browser'],
      },
    });
    const targetLocal = JSON.stringify({
      validation: {
        additionalCommands: ['test:local-check'],
      },
    });

    const readWorktreeFileMock = vi
      .fn()
      .mockImplementation(async (cwd: string, relativePath: string) => {
        if (cwd === '/tmp/automation' && relativePath === '.ai-orchestrator.json')
          return automationBase;
        if (cwd === '/tmp/automation' && relativePath === '.ai-orchestrator.local.json')
          return undefined;
        if (cwd === '/tmp/worktree' && relativePath === '.ai-orchestrator.json') return targetBase;
        if (cwd === '/tmp/worktree' && relativePath === '.ai-orchestrator.local.json')
          return targetLocal;
        return undefined;
      });
    ctx.readWorktreeFile = readWorktreeFileMock;

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: `# Issue 1270
## Acceptance Criteria
- [ ] AC-1: Inherited commands exit-gate:phase1 and exit-gate:phase2 satisfied
- [ ] AC-2: Target command test:browser satisfied
- [ ] AC-3: Local command test:local-check satisfied
`,
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1270',
    });

    await recordValidationEvidence(ctx, 'validate');

    agent.enqueue('spec-review', async () => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'PASS',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Inherited commands exit-gate:phase1 and exit-gate:phase2 satisfied',
              result: 'PASS',
              evidence: 'Inherited from automation layer into effective validation configuration',
            },
            {
              requirement_id: 'AC-2',
              requirement: 'Target command test:browser satisfied',
              result: 'PASS',
              evidence: 'Present in target worktree configuration additionalCommands',
            },
            {
              requirement_id: 'AC-3',
              requirement: 'Local command test:local-check satisfied',
              result: 'PASS',
              evidence: 'Present in target local configuration additionalCommands',
            },
          ],
          findings: [],
          summary: 'All validation command requirements satisfied across supported layers',
        }),
      });
      return {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        resultJsonPath: 'result.json',
        contractViolations: [],
        outcome: 'success',
      };
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('passed');

    expect(readWorktreeFileMock).toHaveBeenCalledWith('/tmp/automation', '.ai-orchestrator.json');
    expect(readWorktreeFileMock).toHaveBeenCalledWith('/tmp/worktree', '.ai-orchestrator.json');
    expect(readWorktreeFileMock).toHaveBeenCalledWith(
      '/tmp/worktree',
      '.ai-orchestrator.local.json',
    );
    expect(readWorktreeFileMock).not.toHaveBeenCalledWith('/tmp/repo', expect.anything());

    const lastCall = mockRenderPrompt.mock.calls[mockRenderPrompt.mock.calls.length - 1];
    const promptCtx = lastCall?.[1];
    const liveConfigPrompt = promptCtx?.vars.live_worktree_configuration;

    expect(liveConfigPrompt).toContain('exit-gate:phase1');
    expect(liveConfigPrompt).toContain('exit-gate:phase2');
    expect(liveConfigPrompt).toContain('test:browser');
    expect(liveConfigPrompt).toContain('test:local-check');
    expect(liveConfigPrompt).toContain('Automation Base');
    expect(liveConfigPrompt).toContain('Target Base');
    expect(liveConfigPrompt).toContain('Target Local');
    expect(liveConfigPrompt).toContain('Status: present');

    const specJson = await artifacts.read(ctx.runUuid, 'spec-review.json');
    const parsed = JSON.parse(specJson);
    expect(parsed.verdict).toBe('PASS');
    expect(parsed.findings).toEqual([]);
    const ledgerRaw = await artifacts.read(ctx.runUuid, 'finding-ledger.json');
    const ledger = JSON.parse(ledgerRaw);
    expect(ledger.entries).toHaveLength(0);
  });

  it('omits sensitive fields such as notifications.runWebhookUrl from live_worktree_configuration prompt variable (finding F-c7127793)', async () => {
    const { ctx, artifacts, agent, handler } = setup();

    const configWithSecrets = JSON.stringify({
      notifications: {
        runWebhookUrl: 'https://secret.example.com/webhook?token=super-secret-xyz-789',
      },
      agent: {
        secretApiKey: 'hidden-secret-key-456',
      },
      validation: {
        commands: ['exit-gate:phase1', 'test:browser'],
      },
    });

    const readWorktreeFileMock = vi
      .fn()
      .mockImplementation(async (cwd: string, relativePath: string) => {
        if (cwd === '/tmp/worktree' && relativePath === '.ai-orchestrator.json')
          return configWithSecrets;
        return undefined;
      });
    ctx.readWorktreeFile = readWorktreeFileMock;

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: `# Issue 1270\n## Acceptance Criteria\n- [ ] AC-1: validation commands present\n`,
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1270',
    });

    await recordValidationEvidence(ctx, 'validate');

    agent.enqueue('spec-review', async () => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'PASS',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'validation commands present',
              result: 'PASS',
              evidence: 'Commands verified',
            },
          ],
          findings: [],
        }),
      });
      return {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        resultJsonPath: 'result.json',
        contractViolations: [],
        outcome: 'success',
      };
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('passed');

    const lastCall = mockRenderPrompt.mock.calls[mockRenderPrompt.mock.calls.length - 1];
    const promptCtx = lastCall?.[1];
    const liveConfigPrompt = promptCtx?.vars.live_worktree_configuration;

    expect(liveConfigPrompt).toContain('exit-gate:phase1');
    expect(liveConfigPrompt).toContain('test:browser');
    expect(liveConfigPrompt).not.toContain('super-secret-xyz-789');
    expect(liveConfigPrompt).not.toContain('hidden-secret-key-456');
    expect(liveConfigPrompt).not.toContain('runWebhookUrl');
  });
});
