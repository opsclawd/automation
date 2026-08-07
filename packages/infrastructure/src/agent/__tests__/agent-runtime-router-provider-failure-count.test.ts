import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentProfileName } from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import type {
  AgentPort,
  AgentInvocationRequest,
  AgentInvocationResult,
} from '@ai-sdlc/application/ports';
import { CONTRACT_VIOLATION_CODES } from '@ai-sdlc/application/ports';
import type { AgentConfig } from '@ai-sdlc/shared';
import { AgentRuntimeRouter } from '../agent-runtime-router.js';

function cfg(): AgentConfig {
  return {
    defaultProfile: 'p1',
    profiles: {
      p1: { runtime: 'opencode', provider: 'anthropic', model: 'm1', timeoutMinutes: 1 },
      p2: { runtime: 'pi', provider: 'local', model: 'm2', timeoutMinutes: 1 },
    },
    phaseProfiles: {
      'plan-design': { profile: 'p1' },
    },
  };
}

function req(overrides: Partial<AgentInvocationRequest> = {}): AgentInvocationRequest {
  return {
    profile: AgentProfileName('p1'),
    promptPath: '/tmp/prompt.md',
    expectedArtifacts: [],
    cwd: '/tmp',
    runId: '00000000-0000-0000-0000-000000000001',
    repoId: 'r1',
    phaseId: 'plan-design',
    startCommitSha: 'a'.repeat(40),
    ...overrides,
  };
}

class SettableAdapter implements AgentPort {
  constructor(public result: AgentInvocationResult) {}
  async invoke(_: AgentInvocationRequest): Promise<AgentInvocationResult> {
    return this.result;
  }
}

const FIXED_NOW = new Date('2026-05-22T12:00:00.000Z');

describe('AgentRuntimeRouter provider failure count annotation', () => {
  let tmpDir: string;
  let inv: FakeAgentInvocationPort;
  let idCounter: number;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'router-provider-failure-count-'));
    inv = new FakeAgentInvocationPort();
    idCounter = 0;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createStderrFile(content: string, name = `stderr-${++idCounter}.log`): string {
    const p = join(tmpDir, name);
    writeFileSync(p, content, 'utf-8');
    return p;
  }

  function makeProviderErrorResult(stderrPath: string): AgentInvocationResult {
    return {
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'm1',
      exitCode: 1,
      durationMs: 100,
      stdoutPath: join(tmpDir, 'stdout.log'),
      stderrPath,
      contractViolations: [CONTRACT_VIOLATION_CODES.PROVIDER_ERROR],
      outcome: 'failed',
    };
  }

  it('annotates the first persisted provider failure with consecutive failures 1', async () => {
    const stderrPath = createStderrFile(
      'Provider error: HTTP 429 Too Many Requests\nDetailed log info',
    );
    const adapter = new SettableAdapter(makeProviderErrorResult(stderrPath));
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter, pi: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => `inv-${++idCounter}`,
      readPromptChars: () => 10,
    });

    const res = await router.invoke(req());

    expect(res.outcome).toBe('failed');
    expect(res.contractViolations).toEqual([CONTRACT_VIOLATION_CODES.PROVIDER_ERROR]);
    const updatedStderr = readFileSync(stderrPath, 'utf-8');
    expect(updatedStderr).toBe(
      'Provider error: HTTP 429 Too Many Requests (consecutive failures: 1)\nDetailed log info',
    );
  });

  it('increments consecutive failures for repeated failures of the same profile', async () => {
    const stderr1 = createStderrFile('Provider error: HTTP 429\n');
    const stderr2 = createStderrFile('Provider error: HTTP 500\n');
    const adapter1 = new SettableAdapter(makeProviderErrorResult(stderr1));
    const router1 = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter1, pi: adapter1 },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => `inv-${++idCounter}`,
      readPromptChars: () => 10,
    });

    await router1.invoke(req());
    expect(readFileSync(stderr1, 'utf-8')).toBe(
      'Provider error: HTTP 429 (consecutive failures: 1)\n',
    );

    const adapter2 = new SettableAdapter(makeProviderErrorResult(stderr2));
    const router2 = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter2, pi: adapter2 },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => `inv-${++idCounter}`,
      readPromptChars: () => 10,
    });

    await router2.invoke(req());
    expect(readFileSync(stderr2, 'utf-8')).toBe(
      'Provider error: HTTP 500 (consecutive failures: 2)\n',
    );
  });

  it('resets the annotation count after a successful invocation for the same profile', async () => {
    const stderr1 = createStderrFile('Provider error: HTTP 429\n');
    const adapter1 = new SettableAdapter(makeProviderErrorResult(stderr1));
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter1, pi: adapter1 },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => `inv-${++idCounter}`,
      readPromptChars: () => 10,
    });

    await router.invoke(req());
    expect(readFileSync(stderr1, 'utf-8')).toBe(
      'Provider error: HTTP 429 (consecutive failures: 1)\n',
    );

    // Successful invocation
    adapter1.result = {
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'm1',
      exitCode: 0,
      durationMs: 100,
      stdoutPath: join(tmpDir, 'stdout.log'),
      stderrPath: createStderrFile('All good\n'),
      contractViolations: [],
      outcome: 'success',
    };
    await router.invoke(req());

    // Another provider failure
    const stderr3 = createStderrFile('Provider error: HTTP 429 again\n');
    adapter1.result = makeProviderErrorResult(stderr3);
    await router.invoke(req());

    expect(readFileSync(stderr3, 'utf-8')).toBe(
      'Provider error: HTTP 429 again (consecutive failures: 1)\n',
    );
  });

  it('does not let another profile reset the provider failure streak', async () => {
    const stderr1 = createStderrFile('Provider error: p1 failure\n');
    const adapter = new SettableAdapter(makeProviderErrorResult(stderr1));
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter, pi: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => `inv-${++idCounter}`,
      readPromptChars: () => 10,
    });

    // Profile p1 fails
    await router.invoke(req({ profile: AgentProfileName('p1') }));
    expect(readFileSync(stderr1, 'utf-8')).toBe(
      'Provider error: p1 failure (consecutive failures: 1)\n',
    );

    // Profile p2 succeeds
    adapter.result = {
      runtime: 'pi',
      provider: 'local',
      model: 'm2',
      exitCode: 0,
      durationMs: 100,
      stdoutPath: join(tmpDir, 'stdout.log'),
      stderrPath: createStderrFile('p2 success\n'),
      contractViolations: [],
      outcome: 'success',
    };
    await router.invoke(req({ profile: AgentProfileName('p2') }));

    // Profile p1 fails again
    const stderr3 = createStderrFile('Provider error: p1 second failure\n');
    adapter.result = makeProviderErrorResult(stderr3);
    await router.invoke(req({ profile: AgentProfileName('p1') }));

    expect(readFileSync(stderr3, 'utf-8')).toBe(
      'Provider error: p1 second failure (consecutive failures: 2)\n',
    );
  });

  it('does not annotate non-provider failures', async () => {
    const stderr = createStderrFile('Runtime error: unexpected panic\nLine 2');
    const adapter = new SettableAdapter({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'm1',
      exitCode: 1,
      durationMs: 100,
      stdoutPath: join(tmpDir, 'stdout.log'),
      stderrPath: stderr,
      contractViolations: [],
      outcome: 'failed',
    });
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter, pi: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => `inv-${++idCounter}`,
      readPromptChars: () => 10,
    });

    const res = await router.invoke(req());

    expect(res.outcome).toBe('failed');
    expect(readFileSync(stderr, 'utf-8')).toBe('Runtime error: unexpected panic\nLine 2');
  });

  it('returns the original provider failure when streak enrichment throws', async () => {
    const adapter = new SettableAdapter(makeProviderErrorResult('/nonexistent/stderr.log'));
    inv.countConsecutiveProviderFailures = () => {
      throw new Error('Repository error counting failures');
    };
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter, pi: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => `inv-${++idCounter}`,
      readPromptChars: () => 10,
    });

    const res = await router.invoke(req());

    expect(res.outcome).toBe('failed');
    expect(res.contractViolations).toEqual([CONTRACT_VIOLATION_CODES.PROVIDER_ERROR]);
  });
});
