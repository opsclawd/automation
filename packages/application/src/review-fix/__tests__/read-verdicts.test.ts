import { describe, it, expect } from 'vitest';
import { PhaseName, RunId, AgentProfileName, AgentInvocationId } from '@ai-sdlc/domain';
import type { AgentInvocation } from '@ai-sdlc/domain';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import { FakeAgentPort } from '../../test-doubles/fake-agent-port.js';
import { FakeStructuredResultRepair } from '../../test-doubles/fake-structured-result-repair.js';
import { readReviewVerdict, readFixVerdict } from '../read-verdicts.js';

function invocation(phase: string, resultJsonPath?: string): AgentInvocation {
  return {
    id: AgentInvocationId('inv-1'),
    runId: RunId('run-1'),
    phaseId: PhaseName(phase),
    profile: AgentProfileName('opencode-frontier'),
    runtime: 'opencode',
    provider: 'anthropic',
    model: 'claude-opus-4.7',
    promptPath: '/wt/prompt.md',
    promptChars: 10,
    stdoutPath: '/wt/out.log',
    stderrPath: '/wt/err.log',
    startedAt: new Date('2026-06-14T00:00:00.000Z'),
    startCommitSha: 'abc',
    timeoutMs: 60000,
    contractViolations: [],
    ...(resultJsonPath ? { resultJsonPath } : {}),
  } as AgentInvocation;
}

describe('readReviewVerdict', () => {
  it("returns 'pass' for a valid whole-pr-review result.json", async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'pass', findings: [] }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(invocation('whole-pr-review', 'result.json'), {
      artifacts,
      agent,
    });
    expect(v).toEqual({ ok: true, verdict: 'pass' });
  });

  it('returns not-ok when result.json is missing (no LLM fallback)', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(invocation('whole-pr-review', undefined), {
      artifacts,
      agent,
    });
    expect(v.ok).toBe(false);
    expect(agent.invocations).toHaveLength(0);
  });
});

describe('readFixVerdict', () => {
  it('maps fix-review result strings', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'done_with_fixes' }),
    });
    const agent = new FakeAgentPort();
    const v = await readFixVerdict(invocation('fix-review', 'result.json'), { artifacts, agent });
    expect(v).toEqual({ ok: true, verdict: 'done_with_fixes' });
  });

  it('carries the rebuttal text for done_no_fixes_needed (#628 P2)', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'done_no_fixes_needed',
        rebuttal: 'the cited code does not exist in this tree',
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readFixVerdict(invocation('fix-review', 'result.json'), { artifacts, agent });
    expect(v).toEqual({
      ok: true,
      verdict: 'done_no_fixes_needed',
      rebuttal: 'the cited code does not exist in this tree',
    });
  });

  it('forwards cwd and repairExpectedHead from readFixVerdict to extractResult', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'read-verdicts-test-'));
    const stdoutPath = join(tempDir, 'stdout.log');
    writeFileSync(stdoutPath, 'evidence');

    try {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'run-1',
        relativePath: 'result.json',
        contents: 'malformed json',
      });

      const repair = new FakeStructuredResultRepair();
      repair.response = async () => {
        await artifacts.write({
          runId: 'run-1',
          relativePath: 'result.json',
          contents: JSON.stringify({ result: 'done_with_fixes' }),
        });
        return { outcome: 'repaired', repairInvocationId: AgentInvocationId('rep-123') };
      };

      const agent = new FakeAgentPort();
      const inv = invocation('fix-review', 'result.json');
      inv.stdoutPath = stdoutPath;
      inv.endCommitSha = 'end-sha-abc';

      const v = await readFixVerdict(
        inv,
        { artifacts, repair, agent },
        { cwd: '/some/cwd', repairExpectedHead: 'custom-repair-head' },
      );

      expect(v).toEqual({ ok: true, verdict: 'done_with_fixes' });
      expect(repair.calls).toHaveLength(1);
      expect(repair.calls[0]?.cwd).toBe('/some/cwd');
      expect(repair.calls[0]?.expectedHead).toBe('custom-repair-head');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('readReviewVerdict severity gate', () => {
  it('pass with blocking high finding is overridden to fail', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'pass',
        findings: [{ severity: 'high', summary: 'unused export' }],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(
      invocation('whole-pr-review', 'result.json'),
      { artifacts, agent },
      { blockOnSeverity: 'high' },
    );
    expect(v).toEqual({
      ok: true,
      verdict: 'fail',
      overridden: true,
      offendingFindings: [{ severity: 'high', summary: 'unused export' }],
    });
  });

  it('pass with only sub-threshold findings still passes', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'pass',
        findings: [{ severity: 'medium', summary: 'style nit' }],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(
      invocation('whole-pr-review', 'result.json'),
      { artifacts, agent },
      { blockOnSeverity: 'high' },
    );
    expect(v).toEqual({ ok: true, verdict: 'pass' });
  });

  it('agent fail with all findings strictly below threshold is overridden to pass', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'fail',
        findings: [
          { severity: 'medium', summary: 'style nit' },
          { severity: 'low', summary: 'cosmetic' },
        ],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(
      invocation('whole-pr-review', 'result.json'),
      { artifacts, agent },
      { blockOnSeverity: 'high' },
    );
    expect(v).toEqual({
      ok: true,
      verdict: 'pass',
      overridden: true,
      offendingFindings: [],
    });
  });

  it('pass with no findings passes regardless of threshold', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'pass',
        findings: [],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(
      invocation('whole-pr-review', 'result.json'),
      { artifacts, agent },
      { blockOnSeverity: 'critical' },
    );
    expect(v).toEqual({ ok: true, verdict: 'pass' });
  });

  it('missing blockOnSeverity preserves existing behavior (pass with critical)', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'pass',
        findings: [{ severity: 'critical', summary: 'data loss' }],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(invocation('whole-pr-review', 'result.json'), {
      artifacts,
      agent,
    });
    expect(v).toEqual({ ok: true, verdict: 'pass' });
  });

  it('threshold "medium" blocks medium findings', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'pass',
        findings: [{ severity: 'medium', summary: 'missing test' }],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(
      invocation('whole-pr-review', 'result.json'),
      { artifacts, agent },
      { blockOnSeverity: 'medium' },
    );
    expect(v).toEqual({
      ok: true,
      verdict: 'fail',
      overridden: true,
      offendingFindings: [{ severity: 'medium', summary: 'missing test' }],
    });
  });

  it('threshold "critical" only blocks critical findings', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'pass',
        findings: [
          { severity: 'high', summary: 'bug' },
          { severity: 'critical', summary: 'data loss' },
        ],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(
      invocation('whole-pr-review', 'result.json'),
      { artifacts, agent },
      { blockOnSeverity: 'critical' },
    );
    expect(v).toEqual({
      ok: true,
      verdict: 'fail',
      overridden: true,
      offendingFindings: [{ severity: 'critical', summary: 'data loss' }],
    });
  });

  it('agent fail with at least one finding at/above threshold is not overridden', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'fail',
        findings: [
          { severity: 'medium', summary: 'style' },
          { severity: 'high', summary: 'real bug' },
        ],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(
      invocation('whole-pr-review', 'result.json'),
      { artifacts, agent },
      { blockOnSeverity: 'high' },
    );
    expect(v).toEqual({
      ok: true,
      verdict: 'fail',
      offendingFindings: [{ severity: 'high', summary: 'real bug' }],
    });
  });

  it('agent fail with empty findings is not overridden (conservative)', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'fail',
        findings: [],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(
      invocation('whole-pr-review', 'result.json'),
      { artifacts, agent },
      { blockOnSeverity: 'high' },
    );
    expect(v).toEqual({ ok: true, verdict: 'fail' });
  });

  it('agent fail with unknown severity is not overridden (conservative)', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'fail',
        findings: [{ severity: 'info', summary: 'note' }],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(
      invocation('whole-pr-review', 'result.json'),
      { artifacts, agent },
      { blockOnSeverity: 'high' },
    );
    expect(v).toEqual({
      ok: true,
      verdict: 'fail',
      offendingFindings: [{ severity: 'info', summary: 'note' }],
    });
  });

  it('agent fail with mixed known and unknown severities keeps fail (conservative)', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'fail',
        findings: [
          { severity: 'low', summary: 'cosmetic' },
          { severity: 'info', summary: 'unparseable note' },
        ],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(
      invocation('whole-pr-review', 'result.json'),
      { artifacts, agent },
      { blockOnSeverity: 'high' },
    );
    // low is below threshold, but info is unknown → conservative: keep fail
    expect(v).toEqual({
      ok: true,
      verdict: 'fail',
      offendingFindings: [
        { severity: 'low', summary: 'cosmetic' },
        { severity: 'info', summary: 'unparseable note' },
      ],
    });
  });

  it('agent fail without a severity gate carries all findings for evidence checks (#628 P1)', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'fail',
        findings: [{ severity: 'high', summary: 'command injection' }],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(invocation('whole-pr-review', 'result.json'), {
      artifacts,
      agent,
    });
    expect(v).toEqual({
      ok: true,
      verdict: 'fail',
      offendingFindings: [{ severity: 'high', summary: 'command injection' }],
    });
  });

  // The spec/quality review prompts instruct reviewers to emit P0-P3
  // severities; the gate must rank them like critical/high/medium/low so
  // blockOnSeverity is not inert for those reviews.
  it('P1 finding blocks at threshold high (alias for critical/high vocab)', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'pass',
        findings: [{ severity: 'P1', summary: 'run object inconsistent with DB patch' }],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(
      invocation('whole-pr-review', 'result.json'),
      { artifacts, agent },
      { blockOnSeverity: 'high' },
    );
    expect(v).toEqual({
      ok: true,
      verdict: 'fail',
      overridden: true,
      offendingFindings: [{ severity: 'P1', summary: 'run object inconsistent with DB patch' }],
    });
  });

  it('agent fail with only P2/P3 findings is overridden to pass at threshold high', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'fail',
        findings: [
          { severity: 'P2', summary: 'test coverage nit' },
          { severity: 'P3', summary: 'naming nit' },
        ],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(
      invocation('whole-pr-review', 'result.json'),
      { artifacts, agent },
      { blockOnSeverity: 'high' },
    );
    expect(v).toEqual({
      ok: true,
      verdict: 'pass',
      overridden: true,
      offendingFindings: [],
    });
  });

  it('P0 finding blocks even at threshold critical', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'fail',
        findings: [
          { severity: 'P0', summary: 'data loss' },
          { severity: 'P1', summary: 'lesser bug' },
        ],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(
      invocation('whole-pr-review', 'result.json'),
      { artifacts, agent },
      { blockOnSeverity: 'critical' },
    );
    expect(v).toEqual({
      ok: true,
      verdict: 'fail',
      offendingFindings: [{ severity: 'P0', summary: 'data loss' }],
    });
  });

  it('mixed P-label and word-label findings rank on one scale', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'fail',
        findings: [
          { severity: 'P2', summary: 'style' },
          { severity: 'high', summary: 'real bug' },
        ],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(
      invocation('whole-pr-review', 'result.json'),
      { artifacts, agent },
      { blockOnSeverity: 'high' },
    );
    expect(v).toEqual({
      ok: true,
      verdict: 'fail',
      offendingFindings: [{ severity: 'high', summary: 'real bug' }],
    });
  });

  it('unknown severity label stays conservative (no override of fail)', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'fail',
        findings: [
          { severity: 'P3', summary: 'nit' },
          { severity: 'P9', summary: 'unmappable label' },
        ],
      }),
    });
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(
      invocation('whole-pr-review', 'result.json'),
      { artifacts, agent },
      { blockOnSeverity: 'high' },
    );
    expect(v).toEqual({
      ok: true,
      verdict: 'fail',
      offendingFindings: [
        { severity: 'P3', summary: 'nit' },
        { severity: 'P9', summary: 'unmappable label' },
      ],
    });
  });
});
