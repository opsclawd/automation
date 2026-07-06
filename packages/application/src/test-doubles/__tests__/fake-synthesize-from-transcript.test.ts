import { AgentInvocationId } from '@ai-sdlc/domain';
import { describe, expect, it } from 'vitest';
import { FakeSynthesizeFromTranscript } from '../fake-synthesize-from-transcript.js';
import type { SynthesizeFromTranscriptInput } from '../../ports/synthesize-from-transcript-port.js';

describe('FakeSynthesizeFromTranscript', () => {
  it('records calls and returns preset response', async () => {
    const fake = new FakeSynthesizeFromTranscript();
    const input: SynthesizeFromTranscriptInput = {
      runId: 'run-123',
      cwd: '/workspace',
      phaseId: 'phase-abc',
      stepIndex: 1,
      primaryInvocation: {
        id: AgentInvocationId('invocation-456'),
        stdoutPath: '/stdout',
        stderrPath: '/stderr',
      },
      missingArtifact: 'implementation-log.md',
      startCommitSha: 'commit-123',
      endCommitSha: 'commit-456',
      primaryExitCode: 0,
      workingTreeDirty: false,
    };

    const result = await fake.synthesizeFromTranscript(input);
    expect(result).toEqual({ outcome: 'no_policy_match' });
    expect(fake.calls).toEqual([input]);
  });

  it('allows dynamic response via a function', async () => {
    const fake = new FakeSynthesizeFromTranscript();
    fake.response = (input) => {
      return {
        outcome: 'synthesized',
        synthesisInvocationId: AgentInvocationId(`synth-${input.runId}`),
      };
    };

    const input: SynthesizeFromTranscriptInput = {
      runId: 'run-123',
      cwd: '/workspace',
      phaseId: 'phase-abc',
      stepIndex: 1,
      primaryInvocation: {
        id: AgentInvocationId('invocation-456'),
        stdoutPath: '/stdout',
        stderrPath: '/stderr',
      },
      missingArtifact: 'implementation-log.md',
      startCommitSha: 'commit-123',
      endCommitSha: 'commit-456',
      primaryExitCode: 0,
      workingTreeDirty: false,
    };

    const result = await fake.synthesizeFromTranscript(input);
    expect(result).toEqual({
      outcome: 'synthesized',
      synthesisInvocationId: 'synth-run-123',
    });
  });

  it('resets calls and response on reset()', async () => {
    const fake = new FakeSynthesizeFromTranscript();
    const input: SynthesizeFromTranscriptInput = {
      runId: 'run-123',
      cwd: '/workspace',
      phaseId: 'phase-abc',
      stepIndex: 1,
      primaryInvocation: {
        id: AgentInvocationId('invocation-456'),
        stdoutPath: '/stdout',
        stderrPath: '/stderr',
      },
      missingArtifact: 'implementation-log.md',
      startCommitSha: 'commit-123',
      endCommitSha: 'commit-456',
      primaryExitCode: 0,
      workingTreeDirty: false,
    };

    fake.response = { outcome: 'synthesized', synthesisInvocationId: AgentInvocationId('synth-1') };
    await fake.synthesizeFromTranscript(input);

    expect(fake.calls.length).toBe(1);

    fake.reset();
    expect(fake.calls.length).toBe(0);
    const resultAfterReset = await fake.synthesizeFromTranscript(input);
    expect(resultAfterReset).toEqual({ outcome: 'no_policy_match' });
  });
});
