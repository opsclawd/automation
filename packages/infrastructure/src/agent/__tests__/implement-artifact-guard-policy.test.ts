import { describe, it, expect, beforeEach } from 'vitest';
import { ImplementArtifactGuard } from '../implement-artifact-guard.js';
import { FakeArtifactStore, FakeGitPort } from '@ai-sdlc/application/test-doubles';

function makeInput(
  overrides: Partial<
    Parameters<ImplementArtifactGuard['synthesizeMissingArtifactsIfDoneDeclared']>[0]
  > = {},
) {
  return {
    runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    cwd: '/tmp/wt',
    phaseId: 'implement',
    stepIndex: 1,
    expectedArtifacts: ['implementation-log.md'],
    invocationEnd: {
      startCommitSha: 'abc123',
      endCommitSha: 'abc123',
      durationMs: 1000,
      outcome: 'contract_violation' as const,
    },
    invocationTranscript: {
      stdoutTail: 'Status: DONE\n',
      stderrTail: '',
    },
    ...overrides,
  };
}

describe('ImplementArtifactGuard policy', () => {
  let artifacts: FakeArtifactStore;
  let git: FakeGitPort;
  let guard: ImplementArtifactGuard;

  beforeEach(() => {
    artifacts = new FakeArtifactStore();
    git = new FakeGitPort();
    git.headByCwd.set('/tmp/wt', 'abc123');
    git.statusByCwd.set('/tmp/wt', '');
    guard = new ImplementArtifactGuard({ artifacts: () => artifacts, git });
  });

  it('synthesizes when DONE declared, no commit, clean tree, no artifact', async () => {
    const result = await guard.synthesizeMissingArtifactsIfDoneDeclared(makeInput());
    expect(result.synthesized).toEqual([
      { artifact: 'implementation-log.md', reason: 'no_op_reverification_done_declared' },
    ]);
    const written = await artifacts.read(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'implementation-log.md',
    );
    expect(written).toContain('Status: DONE');
    expect(written).toContain('abc123');
  });

  it('does NOT synthesize when a commit was created (endSha != startSha)', async () => {
    const result = await guard.synthesizeMissingArtifactsIfDoneDeclared(
      makeInput({
        invocationEnd: {
          startCommitSha: 'abc123',
          endCommitSha: 'def456',
          durationMs: 1000,
          outcome: 'contract_violation' as const,
        },
      }),
    );
    expect(result.synthesized).toEqual([
      { artifact: 'implementation-log.md', reason: 'policy_not_satisfied' },
    ]);
  });

  it('does NOT synthesize when working tree is dirty', async () => {
    git.statusByCwd.set('/tmp/wt', ' M packages/foo.ts');
    const result = await guard.synthesizeMissingArtifactsIfDoneDeclared(makeInput());
    expect(result.synthesized).toEqual([
      { artifact: 'implementation-log.md', reason: 'policy_not_satisfied' },
    ]);
  });

  it('does NOT synthesize when transcript has no DONE-like line and no result.json', async () => {
    const result = await guard.synthesizeMissingArtifactsIfDoneDeclared(
      makeInput({
        invocationTranscript: { stdoutTail: 'thinking...\n', stderrTail: '' },
      }),
    );
    expect(result.synthesized).toEqual([
      { artifact: 'implementation-log.md', reason: 'policy_not_satisfied' },
    ]);
  });

  it('is idempotent: second invocation is a no-op', async () => {
    await guard.synthesizeMissingArtifactsIfDoneDeclared(makeInput());
    const result = await guard.synthesizeMissingArtifactsIfDoneDeclared(makeInput());
    expect(result.synthesized).toEqual([
      { artifact: 'implementation-log.md', reason: 'already_present' },
    ]);
  });

  it('detects DONE in transcript tail line, not just result.json', async () => {
    const result = await guard.synthesizeMissingArtifactsIfDoneDeclared(
      makeInput({
        invocationTranscript: {
          stdoutTail: '... reasoning ...\nStatus: DONE\n',
          stderrTail: '',
        },
      }),
    );
    expect(result.synthesized[0]?.reason).toBe('no_op_reverification_done_declared');
  });

  it('detects DONE in result.json instead of console tails', async () => {
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      phaseId: 'implement',
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'DONE' }),
    });

    const result = await guard.synthesizeMissingArtifactsIfDoneDeclared(
      makeInput({
        invocationTranscript: {
          stdoutTail: 'some text without done',
          stderrTail: '',
          resultJsonPath: 'result.json',
        },
      }),
    );
    expect(result.synthesized[0]?.reason).toBe('no_op_reverification_done_declared');
  });

  it('returns empty when expectedArtifacts does not include implementation-log.md', async () => {
    const result = await guard.synthesizeMissingArtifactsIfDoneDeclared(
      makeInput({ expectedArtifacts: ['some-other-artifact.md'] }),
    );
    expect(result.synthesized).toEqual([]);
  });
});
