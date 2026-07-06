import { describe, it, expect, beforeEach } from 'vitest';
import { AgentInvocationId, AgentProfileName } from '@ai-sdlc/domain';
import {
  type AgentInvocationRequest,
  type AgentInvocationResult,
  type EventBusPort,
  type OrchestratorEvent,
} from '@ai-sdlc/application';
import { FakeArtifactStore, FakeAgentPort, FakeGitPort } from '@ai-sdlc/application/test-doubles';
import { SynthesizeFromTranscript } from '../synthesize-from-transcript.js';

const RUN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PRIMARY_ID = AgentInvocationId('00000000-0000-0000-0000-000000000001');
const RESULT_WRITER_PROFILE = 'task-reviewer';

const WRITER_SUCCESS: AgentInvocationResult = {
  runtime: 'opencode',
  provider: 'p',
  model: 'm',
  exitCode: 0,
  durationMs: 1,
  stdoutPath: '/tmp/syn.stdout',
  stderrPath: '/tmp/syn.stderr',
  contractViolations: [],
  outcome: 'success',
};

function makeBaseInput(
  overrides: Partial<Parameters<SynthesizeFromTranscript['synthesizeFromTranscript']>[0]> = {},
) {
  return {
    runId: RUN_ID,
    cwd: '/tmp/wt',
    phaseId: 'implement',
    stepIndex: 1,
    primaryInvocation: {
      id: PRIMARY_ID,
      stdoutPath: '/tmp/primary.stdout',
      stderrPath: '/tmp/primary.stderr',
    },
    missingArtifact: 'implementation-log.md',
    startCommitSha: 'abc123',
    endCommitSha: 'def456',
    primaryExitCode: 0,
    workingTreeDirty: false,
    ...overrides,
  };
}

class CapturingEventBus implements EventBusPort {
  readonly events: OrchestratorEvent[] = [];
  publish(_runUuid: string, event: OrchestratorEvent): void {
    this.events.push(event);
  }
  subscribe(): () => void {
    return () => {};
  }
}

function writerThatWrites(
  artifacts: FakeArtifactStore,
  relPath: string,
  contents: string,
): (req: AgentInvocationRequest) => Promise<AgentInvocationResult> {
  return async () => {
    await artifacts.write({ runId: RUN_ID, relativePath: relPath, contents });
    return WRITER_SUCCESS;
  };
}

function setup(
  overrides: {
    tail?: string;
    allowlist?: ReadonlySet<string>;
    writer?: (req: AgentInvocationRequest) => Promise<AgentInvocationResult>;
  } = {},
) {
  const artifacts = new FakeArtifactStore();
  const git = new FakeGitPort();
  git.headByCwd.set('/tmp/wt', 'def456');
  git.logBetweenResults.set('abc123|def456', ['commit def456: implement fix']);
  const eventBus = new CapturingEventBus();
  const writer =
    overrides.writer ??
    writerThatWrites(artifacts, 'implementation-log.md', 'Status: DONE\nFiles changed: foo.ts\n');
  const agent = new FakeAgentPort({ [RESULT_WRITER_PROFILE]: [writer] });
  const tail =
    overrides.tail ??
    '... reasoning ...\n' +
      'Some more reasoning details that are long enough to satisfy the 200-byte minimum length requirement for transcript tail verification.\n' +
      '**Status:** DONE\n' +
      'Files changed: foo.ts\n' +
      'All tests passing.\n';
  const guard = new SynthesizeFromTranscript({
    artifacts: () => artifacts,
    git,
    agent,
    eventBus,
    readTailBytes: () => tail,
    ...(overrides.allowlist ? { proseAllowlist: overrides.allowlist } : {}),
  });
  return { guard, artifacts, git, agent, eventBus };
}

describe('SynthesizeFromTranscript policy', () => {
  let env: ReturnType<typeof setup>;

  beforeEach(() => {
    env = setup();
  });

  it('synthesizes when policy matches: prose artifact, exit 0, HEAD advanced, summary markers, tail long enough', async () => {
    const result = await env.guard.synthesizeFromTranscript(makeBaseInput());
    expect(result.outcome).toBe('synthesized');
    expect(result.synthesisInvocationId).toBeDefined();
    expect(env.eventBus.events.some((e) => e.type === 'artifact.synthesized_from_transcript')).toBe(
      true,
    );
    expect(env.agent.invocations).toHaveLength(1);
    const req = env.agent.invocations[0]!;
    expect(req.profile).toBe(AgentProfileName(RESULT_WRITER_PROFILE));
    expect(req.fallbackOfInvocationId).toBe(PRIMARY_ID);
    expect(req.fallbackReason).toBe('synthesized_from_transcript');
    expect(req.expectedArtifacts).toEqual(['implementation-log.md']);
  });

  it('returns no_policy_match when artifact is not in the prose allowlist', async () => {
    const result = await env.guard.synthesizeFromTranscript(
      makeBaseInput({ missingArtifact: 'result.json' }),
    );
    expect(result.outcome).toBe('no_policy_match');
    expect(env.agent.invocations).toHaveLength(0);
    expect(
      env.eventBus.events.some((e) => e.type === 'artifact.synthesis_policy_not_satisfied'),
    ).toBe(true);
  });

  it('returns no_policy_match when primary exit code is non-zero', async () => {
    const result = await env.guard.synthesizeFromTranscript(makeBaseInput({ primaryExitCode: 1 }));
    expect(result.outcome).toBe('no_policy_match');
    expect(env.agent.invocations).toHaveLength(0);
  });

  it('returns no_policy_match when working tree is dirty', async () => {
    const result = await env.guard.synthesizeFromTranscript(
      makeBaseInput({ workingTreeDirty: true }),
    );
    expect(result.outcome).toBe('no_policy_match');
    expect(env.agent.invocations).toHaveLength(0);
  });

  it('returns no_policy_match when HEAD did not advance (existing guard owns this case)', async () => {
    const result = await env.guard.synthesizeFromTranscript(
      makeBaseInput({ endCommitSha: 'abc123' }),
    );
    expect(result.outcome).toBe('no_policy_match');
    expect(env.agent.invocations).toHaveLength(0);
  });

  it('returns no_policy_match when transcript tail is too short and has no summary markers', async () => {
    env = setup({ tail: 'hmm\n' });
    const result = await env.guard.synthesizeFromTranscript(makeBaseInput());
    expect(result.outcome).toBe('no_policy_match');
    expect(env.agent.invocations).toHaveLength(0);
  });

  it('returns no_policy_match when artifact already exists (idempotent)', async () => {
    await env.artifacts.write({
      runId: RUN_ID,
      relativePath: 'implementation-log.md',
      contents: 'Status: DONE (already present)',
    });
    const result = await env.guard.synthesizeFromTranscript(makeBaseInput());
    expect(result.outcome).toBe('no_policy_match');
    expect(env.agent.invocations).toHaveLength(0);
  });

  it('returns synthesis_failed when writer writes BLOCKED', async () => {
    const blockedArtifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/wt', 'def456');
    git.logBetweenResults.set('abc123|def456', ['commit def456: implement fix']);
    const eventBus = new CapturingEventBus();
    const writer = writerThatWrites(
      blockedArtifacts,
      'implementation-log.md',
      'Status: BLOCKED — transcript contradicts diff\n',
    );
    const agent = new FakeAgentPort({ [RESULT_WRITER_PROFILE]: [writer] });
    const guard = new SynthesizeFromTranscript({
      artifacts: () => blockedArtifacts,
      git,
      agent,
      eventBus,
      readTailBytes: () =>
        '... reasoning ...\n' +
        'Some more reasoning details that are long enough to satisfy the 200-byte minimum length requirement for transcript tail verification.\n' +
        '**Status:** DONE\n' +
        'Files changed: foo.ts\n' +
        'All tests passing.\n',
    });
    const result = await guard.synthesizeFromTranscript(makeBaseInput());
    expect(result.outcome).toBe('synthesis_failed');
    expect(eventBus.events.some((e) => e.type === 'artifact.synthesis_failed')).toBe(true);
  });

  it('returns synthesis_failed when writer leaves artifact empty', async () => {
    env = setup({ writer: async () => WRITER_SUCCESS });
    const result = await env.guard.synthesizeFromTranscript(makeBaseInput());
    expect(result.outcome).toBe('synthesis_failed');
  });

  it('returns synthesis_failed when writer throws', async () => {
    env = setup({
      writer: async () => {
        throw new Error('boom');
      },
    });
    const result = await env.guard.synthesizeFromTranscript(makeBaseInput());
    expect(result.outcome).toBe('synthesis_failed');
  });

  it('honors a custom proseAllowlist (e.g., to disable the feature)', async () => {
    env = setup({ allowlist: new Set() });
    const result = await env.guard.synthesizeFromTranscript(makeBaseInput());
    expect(result.outcome).toBe('no_policy_match');
    expect(env.agent.invocations).toHaveLength(0);
  });
});
