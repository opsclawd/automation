import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { AgentProfileName, RunId } from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import { CONTRACT_VIOLATION_CODES } from '@ai-sdlc/application/ports';
import { type AgentConfig, type OrchestratorEvent } from '@ai-sdlc/shared';
import { AgentRuntimeRouter } from '../agent-runtime-router.js';

function cfg(): AgentConfig {
  return {
    defaultProfile: 'opencode-frontier',
    profiles: {
      'opencode-frontier': {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        timeoutMinutes: 1,
      },
      'pi-local': {
        runtime: 'pi',
        provider: 'local',
        model: 'q',
        timeoutMinutes: 1,
        contextLimitTokens: 64000,
      },
    },
    phaseProfiles: {
      'plan-design': { profile: 'opencode-frontier', fallbackProfile: 'pi-local' },
    },
  };
}

function req(overrides: Partial<AgentInvocationRequest> = {}): AgentInvocationRequest {
  return {
    profile: AgentProfileName('opencode-frontier'),
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

class StubAdapter implements AgentPort {
  constructor(private readonly result: AgentInvocationResult) {}
  async invoke(_: AgentInvocationRequest): Promise<AgentInvocationResult> {
    return this.result;
  }
}

class FailingTwiceAdapter implements AgentPort {
  private callCount = 0;
  constructor(
    private readonly firstResult: AgentInvocationResult,
    private readonly secondResult: AgentInvocationResult,
  ) {}
  async invoke(_: AgentInvocationRequest): Promise<AgentInvocationResult> {
    this.callCount++;
    if (this.callCount === 1) return this.firstResult;
    return this.secondResult;
  }
}

const FIXED_NOW = new Date('2026-05-22T12:00:00.000Z');

describe('AgentRuntimeRouter fallback', () => {
  const triggerVariants: Array<{
    name: string;
    result: AgentInvocationResult;
    expectedReason: string;
  }> = [
    {
      name: 'timeout',
      result: {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [],
        outcome: 'timeout',
      },
      expectedReason: 'timeout',
    },
    {
      name: 'prompt_budget_exceeded',
      result: {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [CONTRACT_VIOLATION_CODES.PROMPT_BUDGET_EXCEEDED],
        outcome: 'contract_violation',
      },
      expectedReason: 'prompt_budget_exceeded',
    },
    {
      name: 'missing_required_artifact',
      result: {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT],
        outcome: 'contract_violation',
      },
      expectedReason: 'missing_required_artifact',
    },
    {
      name: 'invalid_result_json',
      result: {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [CONTRACT_VIOLATION_CODES.INVALID_RESULT_JSON],
        outcome: 'contract_violation',
      },
      expectedReason: 'invalid_result_json',
    },
    {
      name: 'generic_contract_violation',
      result: {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: ['some_other_violation'],
        outcome: 'contract_violation',
      },
      expectedReason: 'contract_violation',
    },
    {
      name: 'provider_error',
      result: {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [CONTRACT_VIOLATION_CODES.PROVIDER_ERROR],
        outcome: 'failed',
      },
      expectedReason: 'provider_error',
    },
    {
      name: 'no_output',
      result: {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [CONTRACT_VIOLATION_CODES.NO_OUTPUT],
        outcome: 'contract_violation',
      },
      expectedReason: 'no_output',
    },
  ];

  const serializationTriggers = new Set([
    'missing_required_artifact',
    'invalid_result_json',
    'no_output',
  ]);

  triggerVariants.forEach(({ name, result: triggerResult, expectedReason }) => {
    it('escalates to fallback profile on ' + name, async () => {
      const inv = new FakeAgentInvocationPort();
      const adapter = new StubAdapter(triggerResult);
      const events: OrchestratorEvent[] = [];
      const router = new AgentRuntimeRouter({
        agent: cfg(),
        adapters: { opencode: adapter, pi: adapter },
        invocationRepository: inv,
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-fallback-' + name,
        readPromptChars: () => 100,
        eventBus: {
          publish(_runId, ev) {
            events.push(ev);
          },
        },
      });

      await router.invoke(req());

      const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));

      if (serializationTriggers.has(name)) {
        expect(rows.length).toBe(1);
        expect(rows[0].outcome).toBe(triggerResult.outcome);
        expect(events.length).toBe(0);
      } else {
        // Two rows: first (failed) + second (fallback)
        expect(rows.length).toBe(2);

        // First row is the original failure
        expect(rows[0].outcome).toBe(triggerResult.outcome);

        // Second row has fallbackOfInvocationId set
        expect(rows[1].fallbackOfInvocationId).toBeDefined();
        expect(String(rows[1].fallbackOfInvocationId)).toBe('inv-fallback-' + name);

        // Event emitted with triggerOwner: 'router'
        expect(events.length).toBe(1);
        expect(events[0].type).toBe('phase.fallback.escalated');
        expect(events[0].metadata.triggerOwner).toBe('router');
        expect(events[0].metadata.triggerReason).toBe(expectedReason);
        expect(events[0].metadata.fromProfile).toBe('opencode-frontier');
        expect(events[0].metadata.toProfile).toBe('pi-local');
      }
    });
  });

  it('fallback invocation row records env override values', async () => {
    const inv = new FakeAgentInvocationPort();
    const adapter = new FailingTwiceAdapter(
      {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 1,
        durationMs: 500,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [],
        outcome: 'timeout',
      },
      {
        runtime: 'pi',
        provider: 'local',
        model: 'glm-5.1',
        exitCode: 0,
        durationMs: 600,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [],
        outcome: 'success',
      },
    );
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter, pi: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-fb-env',
      readPromptChars: () => 100,
      env: { AI_AGENT_MODEL: 'glm-5.1' },
    });

    await router.invoke(req());

    const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
    expect(rows.length).toBe(2);

    // First row (original) — provider from profile, model overridden
    expect(rows[0].provider).toBe('anthropic');
    expect(rows[0].model).toBe('glm-5.1');

    // Second row (fallback) — provider from fallback profile, model overridden
    expect(rows[1].provider).toBe('local');
    expect(rows[1].model).toBe('glm-5.1');
    expect(rows[1].fallbackOfInvocationId).toBeDefined();
  });

  it('bounds fallback to one hop when fallback also fails', async () => {
    const inv = new FakeAgentInvocationPort();
    const events: OrchestratorEvent[] = [];
    const adapter = new FailingTwiceAdapter(
      {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 1,
        durationMs: 500,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [],
        outcome: 'timeout',
      },
      {
        runtime: 'pi',
        provider: 'local',
        model: 'q',
        exitCode: 1,
        durationMs: 600,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [],
        outcome: 'failed',
      },
    );
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter, pi: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-bounded',
      readPromptChars: () => 100,
      eventBus: {
        publish(_runId, ev) {
          events.push(ev);
        },
      },
    });

    const result = await router.invoke(req());

    // Result is the fallback failure (no third invocation)
    expect(result.outcome).toBe('failed');

    // Exactly two rows total
    const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
    expect(rows.length).toBe(2);

    // Second row has fallbackOfInvocationId
    expect(rows[1].fallbackOfInvocationId).toBeDefined();

    // Event emitted (router-triggered)
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('phase.fallback.escalated');
  });

  describe('runtime_error trigger', () => {
    it('escalates to fallback profile on runtime_error when configured', async () => {
      const inv = new FakeAgentInvocationPort();
      const adapter = new StubAdapter({
        runtime: 'opencode',
        provider: 'opencode',
        model: 'deepseek-v4-flash',
        exitCode: 1,
        durationMs: 2000,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [],
        outcome: 'failed',
      });
      const events: OrchestratorEvent[] = [];
      const config = cfg();
      config.phaseProfiles['plan-design'].fallbackTriggers = ['runtime_error'];
      const router = new AgentRuntimeRouter({
        agent: config,
        adapters: { opencode: adapter, pi: adapter },
        invocationRepository: inv,
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-runtime-error',
        readPromptChars: () => 100,
        eventBus: {
          publish(_runId, ev) {
            events.push(ev);
          },
        },
      });

      await router.invoke(req());

      const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
      expect(rows.length).toBe(2);
      expect(rows[0].outcome).toBe('failed');
      expect(rows[1].fallbackOfInvocationId).toBeDefined();
      expect(events.length).toBe(1);
      expect(events[0].metadata.triggerReason).toBe('runtime_error');
    });
  });

  describe('token_limit_exceeded trigger', () => {
    it('escalates to fallback profile on token_limit_exceeded when stderr matches', async () => {
      const stderrPath = '/tmp/test-stderr-tle.log';
      writeFileSync(stderrPath, 'Error: context_length_exceeded: prompt is too long');
      let cleanup = true;
      const inv = new FakeAgentInvocationPort();
      const adapter = new StubAdapter({
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 1,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath,
        contractViolations: [],
        outcome: 'failed',
      });
      const events: OrchestratorEvent[] = [];
      const config = cfg();
      config.phaseProfiles['plan-design'].fallbackTriggers = ['token_limit_exceeded'];
      const router = new AgentRuntimeRouter({
        agent: config,
        adapters: { opencode: adapter, pi: adapter },
        invocationRepository: inv,
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-tle',
        readPromptChars: () => 100,
        eventBus: {
          publish(_runId, ev) {
            events.push(ev);
          },
        },
      });

      try {
        await router.invoke(req());

        const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
        expect(rows.length).toBe(2);
        expect(events[0].metadata.triggerReason).toBe('token_limit_exceeded');
      } finally {
        if (cleanup) unlinkSync(stderrPath);
      }
    });

    it('does not trigger token_limit_exceeded when stderr has no token-limit pattern', async () => {
      const stderrPath = '/tmp/test-stderr-no-tle.log';
      writeFileSync(stderrPath, 'Error: Model not found: opencode/deepseek-v4-flash');
      let cleanup = true;
      const inv = new FakeAgentInvocationPort();
      const adapter = new StubAdapter({
        runtime: 'opencode',
        provider: 'opencode',
        model: 'deepseek-v4-flash',
        exitCode: 1,
        durationMs: 2000,
        stdoutPath: '/s',
        stderrPath,
        contractViolations: [],
        outcome: 'failed',
      });
      const events: OrchestratorEvent[] = [];
      const config = cfg();
      config.phaseProfiles['plan-design'].fallbackTriggers = ['token_limit_exceeded'];
      const router = new AgentRuntimeRouter({
        agent: config,
        adapters: { opencode: adapter, pi: adapter },
        invocationRepository: inv,
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-no-tle',
        readPromptChars: () => 100,
        eventBus: {
          publish(_runId, ev) {
            events.push(ev);
          },
        },
      });

      try {
        await router.invoke(req());

        const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
        expect(rows.length).toBe(1);
        expect(events.length).toBe(0);
      } finally {
        if (cleanup) unlinkSync(stderrPath);
      }
    });

    it('triggers token_limit_exceeded when stderr contains underscore-delimited token_limit_exceeded', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'router-fallback-tle-underscore-'));
      const stderrPath = join(tmpDir, 'stderr.log');
      writeFileSync(
        stderrPath,
        'Error code: token_limit_exceeded — The model context window was exceeded.',
      );
      let cleanup = true;
      const inv = new FakeAgentInvocationPort();
      const adapter = new StubAdapter({
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 1,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath,
        contractViolations: [],
        outcome: 'failed',
      });
      const config = cfg();
      config.phaseProfiles['plan-design'].fallbackTriggers = ['token_limit_exceeded'];
      const router = new AgentRuntimeRouter({
        agent: config,
        adapters: { opencode: adapter, pi: adapter },
        invocationRepository: inv,
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-tle-underscore',
        readPromptChars: () => 100,
      });

      try {
        await router.invoke(req());

        const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
        // Should escalate to fallback — token_limit_exceeded triggers fallback
        expect(rows.length).toBe(2);
      } finally {
        if (cleanup) rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('triggers token_limit_exceeded on various natural language forms of token limit errors', async () => {
      const cases = ['token usage limit exceeded', 'Token limit exceeded'];
      for (const text of cases) {
        const tmpDir = mkdtempSync(
          join(tmpdir(), `router-fallback-tle-cases-${text.replace(/\s+/g, '-')}-`),
        );
        const stderrPath = join(tmpDir, 'stderr.log');
        writeFileSync(stderrPath, text);
        let cleanup = true;
        const inv = new FakeAgentInvocationPort();
        const adapter = new StubAdapter({
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'm',
          exitCode: 1,
          durationMs: 1000,
          stdoutPath: '/s',
          stderrPath,
          contractViolations: [],
          outcome: 'failed',
        });
        const config = cfg();
        config.phaseProfiles['plan-design'].fallbackTriggers = ['token_limit_exceeded'];
        const router = new AgentRuntimeRouter({
          agent: config,
          adapters: { opencode: adapter, pi: adapter },
          invocationRepository: inv,
          clock: () => FIXED_NOW,
          idFactory: () => 'inv-tle-case',
          readPromptChars: () => 100,
        });

        try {
          await router.invoke(req());
          const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
          expect(rows.length).toBe(2);
        } finally {
          if (cleanup) rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    });

    it('does not trigger token_limit_exceeded when stderr matches literal token.*limit regex pattern string', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'router-fallback-tle-literal-regex-'));
      const stderrPath = join(tmpDir, 'stderr.log');
      writeFileSync(
        stderrPath,
        "export REVIEWER_PROVIDER_ERROR_PATTERNS='AI_APICallError|RESOURCE_EXHAUSTED|token.*limit.*exceed'",
      );
      let cleanup = true;
      const inv = new FakeAgentInvocationPort();
      const adapter = new StubAdapter({
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 1,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath,
        contractViolations: [],
        outcome: 'failed',
      });
      const config = cfg();
      config.phaseProfiles['plan-design'].fallbackTriggers = ['token_limit_exceeded'];
      const router = new AgentRuntimeRouter({
        agent: config,
        adapters: { opencode: adapter, pi: adapter },
        invocationRepository: inv,
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-tle-literal',
        readPromptChars: () => 100,
      });

      try {
        await router.invoke(req());
        const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
        expect(rows.length).toBe(1);
      } finally {
        if (cleanup) rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('quota_exceeded trigger', () => {
    it('escalates to fallback profile on quota_exceeded when stderr matches', async () => {
      const stderrPath = '/tmp/test-stderr-qe.log';
      writeFileSync(
        stderrPath,
        'Error: Usage limit reached for 5 hour. Your limit will reset at 2026-05-29 07:10:54',
      );
      let cleanup = true;
      const inv = new FakeAgentInvocationPort();
      const adapter = new StubAdapter({
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 1,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath,
        contractViolations: [],
        outcome: 'failed',
      });
      const events: OrchestratorEvent[] = [];
      const config = cfg();
      config.phaseProfiles['plan-design'].fallbackTriggers = ['quota_exceeded'];
      const router = new AgentRuntimeRouter({
        agent: config,
        adapters: { opencode: adapter, pi: adapter },
        invocationRepository: inv,
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-qe',
        readPromptChars: () => 100,
        eventBus: {
          publish(_runId, ev) {
            events.push(ev);
          },
        },
      });

      try {
        await router.invoke(req());

        const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
        expect(rows.length).toBe(2);
        expect(events[0].metadata.triggerReason).toBe('quota_exceeded');
      } finally {
        if (cleanup) unlinkSync(stderrPath);
      }
    });

    it('does not trigger quota_exceeded when stderr has no quota pattern', async () => {
      const stderrPath = '/tmp/test-stderr-no-qe.log';
      writeFileSync(stderrPath, 'Error: Model not found: opencode/deepseek-v4-flash');
      let cleanup = true;
      const inv = new FakeAgentInvocationPort();
      const adapter = new StubAdapter({
        runtime: 'opencode',
        provider: 'opencode',
        model: 'deepseek-v4-flash',
        exitCode: 1,
        durationMs: 2000,
        stdoutPath: '/s',
        stderrPath,
        contractViolations: [],
        outcome: 'failed',
      });
      const events: OrchestratorEvent[] = [];
      const config = cfg();
      config.phaseProfiles['plan-design'].fallbackTriggers = ['quota_exceeded'];
      const router = new AgentRuntimeRouter({
        agent: config,
        adapters: { opencode: adapter, pi: adapter },
        invocationRepository: inv,
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-no-qe',
        readPromptChars: () => 100,
        eventBus: {
          publish(_runId, ev) {
            events.push(ev);
          },
        },
      });

      try {
        await router.invoke(req());

        const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
        expect(rows.length).toBe(1);
        expect(events.length).toBe(0);
      } finally {
        if (cleanup) unlinkSync(stderrPath);
      }
    });

    it('triggers quota_exceeded as a default trigger when fallbackTriggers is not set', async () => {
      const stderrPath = '/tmp/test-stderr-qe-default.log';
      writeFileSync(stderrPath, 'rate_limit_exceeded: too many requests');
      let cleanup = true;
      const inv = new FakeAgentInvocationPort();
      const adapter = new StubAdapter({
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 1,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath,
        contractViolations: [],
        outcome: 'failed',
      });
      const events: OrchestratorEvent[] = [];
      const router = new AgentRuntimeRouter({
        agent: cfg(),
        adapters: { opencode: adapter, pi: adapter },
        invocationRepository: inv,
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-qe-default',
        readPromptChars: () => 100,
        eventBus: {
          publish(_runId, ev) {
            events.push(ev);
          },
        },
      });

      try {
        await router.invoke(req());

        const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
        expect(rows.length).toBe(2);
        expect(events[0].metadata.triggerReason).toBe('quota_exceeded');
      } finally {
        if (cleanup) unlinkSync(stderrPath);
      }
    });

    it('triggers quota_exceeded on crofai "Not Enough Credits" in stderr', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'router-fallback-crofai-qe-'));
      const stderrPath = join(tmpDir, 'stderr.log');
      writeFileSync(
        stderrPath,
        'QUOTA_EXCEEDED: ERROR 2026-06-03T12:00:04.000Z +0ms service=llm {"error":{"code":401,"message":"Not Enough Credits","type":"unauthorized"}}',
      );
      let cleanup = true;
      const inv = new FakeAgentInvocationPort();
      const adapter = new StubAdapter({
        runtime: 'opencode',
        provider: 'crofai',
        model: 'glm-5.1',
        exitCode: 0,
        durationMs: 4000,
        stdoutPath: '/s',
        stderrPath,
        contractViolations: [],
        outcome: 'failed',
      });
      const events: OrchestratorEvent[] = [];
      const config = cfg();
      config.phaseProfiles['plan-design'].fallbackTriggers = ['quota_exceeded'];
      const router = new AgentRuntimeRouter({
        agent: config,
        adapters: { opencode: adapter, pi: adapter },
        invocationRepository: inv,
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-crofai-qe',
        readPromptChars: () => 100,
        eventBus: {
          publish(_runId, ev) {
            events.push(ev);
          },
        },
      });
      try {
        await router.invoke(req());
        const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
        expect(rows.length).toBe(2);
        expect(events[0].metadata.triggerReason).toBe('quota_exceeded');
      } finally {
        if (cleanup) rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('fallbackTriggers configuration', () => {
    it('does NOT trigger fallback for missing_required_artifact even when configured', async () => {
      const config: AgentConfig = {
        defaultProfile: 'opencode-frontier',
        profiles: {
          'opencode-frontier': {
            runtime: 'opencode',
            provider: 'anthropic',
            model: 'm',
            timeoutMinutes: 1,
          },
          'pi-local': {
            runtime: 'pi',
            provider: 'local',
            model: 'q',
            timeoutMinutes: 1,
            contextLimitTokens: 64000,
          },
        },
        phaseProfiles: {
          implement: {
            profile: 'opencode-frontier',
            fallbackProfile: 'pi-local',
            fallbackTriggers: ['missing_required_artifact'],
          },
        },
      };
      const cheap = new StubAdapter({
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT],
        outcome: 'contract_violation',
      });
      const frontier = new StubAdapter({
        runtime: 'pi',
        provider: 'local',
        model: 'q',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [],
        outcome: 'success',
      });
      const inv = new FakeAgentInvocationPort();
      const router = new AgentRuntimeRouter({
        agent: config,
        adapters: { opencode: cheap, pi: frontier },
        invocationRepository: inv,
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-fbt-1',
        readPromptChars: () => 100,
      });

      await router.invoke(req({ phaseId: 'implement' }));

      const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
      expect(rows.length).toBe(1);
    });

    it('does NOT trigger fallback for timeout when fallbackTriggers only has contract_violation', async () => {
      const config: AgentConfig = {
        defaultProfile: 'opencode-frontier',
        profiles: {
          'opencode-frontier': {
            runtime: 'opencode',
            provider: 'anthropic',
            model: 'm',
            timeoutMinutes: 1,
          },
          'pi-local': {
            runtime: 'pi',
            provider: 'local',
            model: 'q',
            timeoutMinutes: 1,
            contextLimitTokens: 64000,
          },
        },
        phaseProfiles: {
          implement: {
            profile: 'opencode-frontier',
            fallbackProfile: 'pi-local',
            fallbackTriggers: ['contract_violation'],
          },
        },
      };
      const cheap = new StubAdapter({
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [],
        outcome: 'timeout',
      });
      const frontier = new StubAdapter({
        runtime: 'pi',
        provider: 'local',
        model: 'q',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [],
        outcome: 'success',
      });
      const inv = new FakeAgentInvocationPort();
      const router = new AgentRuntimeRouter({
        agent: config,
        adapters: { opencode: cheap, pi: frontier },
        invocationRepository: inv,
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-fbt-2',
        readPromptChars: () => 100,
      });

      await router.invoke(req({ phaseId: 'implement' }));

      const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
      expect(rows.length).toBe(1);
    });

    it('defaults to timeout, contract_violation, runtime_error, token_limit_exceeded, and quota_exceeded when fallbackTriggers is not set', async () => {
      const config: AgentConfig = {
        defaultProfile: 'opencode-frontier',
        profiles: {
          'opencode-frontier': {
            runtime: 'opencode',
            provider: 'anthropic',
            model: 'm',
            timeoutMinutes: 1,
          },
          'pi-local': {
            runtime: 'pi',
            provider: 'local',
            model: 'q',
            timeoutMinutes: 1,
            contextLimitTokens: 64000,
          },
        },
        phaseProfiles: {
          implement: {
            profile: 'opencode-frontier',
            fallbackProfile: 'pi-local',
          },
        },
      };
      const cheap = new StubAdapter({
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [],
        outcome: 'timeout',
      });
      const frontier = new StubAdapter({
        runtime: 'pi',
        provider: 'local',
        model: 'q',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [],
        outcome: 'success',
      });
      const inv = new FakeAgentInvocationPort();
      const router = new AgentRuntimeRouter({
        agent: config,
        adapters: { opencode: cheap, pi: frontier },
        invocationRepository: inv,
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-fbt-3',
        readPromptChars: () => 100,
      });

      await router.invoke(req({ phaseId: 'implement' }));

      const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
      expect(rows.length).toBe(2);
    });

    it('triggers fallback for provider_error by default (no fallbackTriggers override)', async () => {
      const inv = new FakeAgentInvocationPort();
      const adapter = new StubAdapter({
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [CONTRACT_VIOLATION_CODES.PROVIDER_ERROR],
        outcome: 'failed',
      });
      const router = new AgentRuntimeRouter({
        agent: cfg(),
        adapters: { opencode: adapter, pi: adapter },
        invocationRepository: inv,
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-pe-default',
        readPromptChars: () => 100,
      });

      await router.invoke(req());

      const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
      expect(rows.length).toBe(2);
    });

    it('does NOT trigger fallback for no_output by default', async () => {
      const inv = new FakeAgentInvocationPort();
      const adapter = new StubAdapter({
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        exitCode: 0,
        durationMs: 1000,
        stdoutPath: '/s',
        stderrPath: '/e',
        contractViolations: [CONTRACT_VIOLATION_CODES.NO_OUTPUT],
        outcome: 'contract_violation',
      });
      const router = new AgentRuntimeRouter({
        agent: cfg(),
        adapters: { opencode: adapter, pi: adapter },
        invocationRepository: inv,
        clock: () => FIXED_NOW,
        idFactory: () => 'inv-no-default',
        readPromptChars: () => 100,
      });

      await router.invoke(req());

      const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
      expect(rows.length).toBe(1);
    });
  });
});

describe('AgentRuntimeRouter arbiter-phase fallback (post #676 rename)', () => {
  it('fires fallbackProfile when arbiter invocation fails on provider_error (regression for issue #671)', async () => {
    const inv = new FakeAgentInvocationPort();
    const agentConfig = cfg();
    agentConfig.phaseProfiles.arbiter = {
      profile: 'opencode-frontier',
      fallbackProfile: 'pi-local',
    };

    const router = new AgentRuntimeRouter({
      agent: agentConfig,
      adapters: {
        opencode: new StubAdapter({
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'm',
          exitCode: 0,
          durationMs: 4000,
          stdoutPath: '/s',
          stderrPath: '/e',
          contractViolations: [CONTRACT_VIOLATION_CODES.PROVIDER_ERROR],
          outcome: 'failed',
        }),
        pi: new StubAdapter({
          runtime: 'pi',
          provider: 'local',
          model: 'q',
          exitCode: 0,
          durationMs: 1000,
          stdoutPath: '/s',
          stderrPath: '/e',
          contractViolations: [],
          outcome: 'success',
        }),
      },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-arbiter-fb',
      readPromptChars: () => 100,
    });

    const result = await router.invoke(
      req({ phaseId: 'arbiter', profile: AgentProfileName('opencode-frontier') }),
    );

    // Primary failure surfaces as a fallback dispatch
    expect(result.outcome).toBe('success');
    expect(result.provider).toBe('local');

    // Two rows persisted: primary failure + fallback success
    const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
    expect(rows.length).toBe(2);
    expect(rows[0]?.phaseId).toBe('arbiter');
    expect(rows[1]?.fallbackOfInvocationId).toBe(rows[0]?.id);
  });

  it('fires fallbackProfile when arbiter invocation fails on quota_exceeded (default trigger)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'router-fallback-arbiter-qe-'));
    const stderrPath = join(tmpDir, 'stderr.log');
    writeFileSync(
      stderrPath,
      'Error: Usage limit reached for 5 hour. Your limit will reset at 2026-05-29 07:10:54',
    );
    let cleanup = true;

    const inv = new FakeAgentInvocationPort();
    const agentConfig = cfg();
    agentConfig.phaseProfiles.arbiter = {
      profile: 'opencode-frontier',
      fallbackProfile: 'pi-local',
    };

    const router = new AgentRuntimeRouter({
      agent: agentConfig,
      adapters: {
        opencode: new StubAdapter({
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'm',
          exitCode: 1,
          durationMs: 4000,
          stdoutPath: '/s',
          stderrPath,
          contractViolations: [],
          outcome: 'failed',
        }),
        pi: new StubAdapter({
          runtime: 'pi',
          provider: 'local',
          model: 'q',
          exitCode: 0,
          durationMs: 1000,
          stdoutPath: '/s',
          stderrPath: '/e',
          contractViolations: [],
          outcome: 'success',
        }),
      },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-arbiter-qf',
      readPromptChars: () => 100,
    });

    try {
      const result = await router.invoke(
        req({ phaseId: 'arbiter', profile: AgentProfileName('opencode-frontier') }),
      );

      expect(result.outcome).toBe('success');
      expect(result.provider).toBe('local');
      const rows = inv.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
      expect(rows.length).toBe(2);
      expect(rows[0]?.phaseId).toBe('arbiter');
      expect(rows[1]?.fallbackOfInvocationId).toBe(rows[0]?.id);
    } finally {
      if (cleanup) rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
