import { describe, it, expect } from 'vitest';
import { AgentRuntimeRouter } from '../agent-runtime-router.js';
import { AgentProfileName, AgentInvocationId, RunId, PhaseName } from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AgentInvocationRequest, AgentInvocationResult, AgentPort, EventBusPort } from '@ai-sdlc/application/ports';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

describe('AgentRuntimeRouter error parsing', () => {
  const FIXED_NOW = new Date('2026-07-08T22:10:00Z');

  function setup(stderrContent: string) {
    const tmp = join(tmpdir(), `__tmp_error_parse_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    const stderrPath = join(tmp, 'stderr.log');
    writeFileSync(stderrPath, stderrContent + '\n', 'utf-8');

    const events: OrchestratorEvent[] = [];
    const eventBus: EventBusPort = {
      subscribe: () => () => {},
      publish: (_runId: string, event: OrchestratorEvent) => {
        events.push(event);
      },
    };

    const agentConfig = {
      defaultProfile: 'primary',
      profiles: {
        primary: { runtime: 'opencode' as any, provider: 'opencode', model: 'mimo', timeoutMinutes: 1 },
        fallback: { runtime: 'opencode' as any, provider: 'openai', model: 'gpt-4', timeoutMinutes: 1 },
      },
      phaseProfiles: {
        'plan-design': {
          profile: 'primary',
          fallbackProfile: 'fallback',
          fallbackTriggers: ['quota_exceeded', 'token_limit_exceeded', 'provider_error'],
        },
      },
    };

    const adapter: AgentPort = {
      async invoke(req: AgentInvocationRequest): Promise<AgentInvocationResult> {
        if (req.profile === 'primary') {
          return {
            runtime: 'opencode' as any,
            provider: 'opencode',
            model: 'mimo',
            exitCode: 1,
            durationMs: 100,
            stdoutPath: join(tmp, 'stdout.log'),
            stderrPath,
            contractViolations: [],
            outcome: 'failed',
          };
        }
        return {
          runtime: 'opencode' as any,
          provider: 'openai',
          model: 'gpt-4',
          exitCode: 0,
          durationMs: 100,
          stdoutPath: join(tmp, 'stdout2.log'),
          stderrPath: join(tmp, 'stderr2.log'),
          contractViolations: [],
          outcome: 'success',
        };
      },
    };

    const router = new AgentRuntimeRouter({
      agent: agentConfig as any,
      adapters: { opencode: adapter },
      invocationRepository: new FakeAgentInvocationPort(),
      eventBus,
      clock: () => FIXED_NOW,
    });

    return { router, events, tmp };
  }

  it('parses OpenCode quota error with JSON blob', async () => {
    const logLine = 'ERROR 2026-07-08T22:09:50 +398ms service=llm providerID=opencode modelID=mimo-v2.5-free error={"error":{"name":"AI_APICallError","statusCode":429,"message":"Rate limit exceeded."}}';
    const { router, events, tmp } = setup(logLine);

    await router.invoke({
      profile: AgentProfileName('primary'),
      promptPath: join(tmp, 'prompt.md'),
      expectedArtifacts: [],
      cwd: tmp,
      runId: 'run-1',
      repoId: 'repo-1',
      phaseId: 'plan-design',
      startCommitSha: 'sha',
    });

    const ev = events.find(e => e.type === 'phase.fallback.escalated')!;
    expect(ev.message).toContain('HTTP 429: "Rate limit exceeded."');
    expect(ev.metadata.triggerReason).toBe('quota_exceeded');
    expect(ev.metadata.triggerDetail).toBe(logLine);

    rmSync(tmp, { recursive: true, force: true });
  });

  it('parses OpenCode token limit error with JSON blob', async () => {
    const logLine = 'ERROR 2026-07-08T22:09:50 +398ms service=llm providerID=opencode error={"error":{"statusCode":400,"message":"Context length exceeded."}}';
    // We need a line that matches TOKEN_LIMIT_PATTERNS
    const logLineWithPattern = logLine + ' context_length_exceeded';
    const { router, events, tmp } = setup(logLineWithPattern);

    await router.invoke({
      profile: AgentProfileName('primary'),
      promptPath: join(tmp, 'prompt.md'),
      expectedArtifacts: [],
      cwd: tmp,
      runId: 'run-1',
      repoId: 'repo-1',
      phaseId: 'plan-design',
      startCommitSha: 'sha',
    });

    const ev = events.find(e => e.type === 'phase.fallback.escalated')!;
    expect(ev.message).toContain('HTTP 400: "Context length exceeded."');
    expect(ev.metadata.triggerReason).toBe('token_limit_exceeded');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('parses OpenCode generic provider error with JSON blob', async () => {
    const logLine = 'ERROR 2026-07-08T22:09:50 +398ms service=llm error={"error":{"statusCode":500,"message":"Internal Server Error"}} AI_APICallError';
    const { router, events, tmp } = setup(logLine);

    await router.invoke({
      profile: AgentProfileName('primary'),
      promptPath: join(tmp, 'prompt.md'),
      expectedArtifacts: [],
      cwd: tmp,
      runId: 'run-1',
      repoId: 'repo-1',
      phaseId: 'plan-design',
      startCommitSha: 'sha',
    });

    const ev = events.find(e => e.type === 'phase.fallback.escalated')!;
    expect(ev.message).toContain('HTTP 500: "Internal Server Error"');
    expect(ev.metadata.triggerReason).toBe('provider_error');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('falls back to truncated raw line for malformed JSON', async () => {
    const logLine = 'ERROR 2026-07-08T22:09:50 +398ms service=llm error={"error":{malformed}} "statusCode": 429';
    const { router, events, tmp } = setup(logLine);

    await router.invoke({
      profile: AgentProfileName('primary'),
      promptPath: join(tmp, 'prompt.md'),
      expectedArtifacts: [],
      cwd: tmp,
      runId: 'run-1',
      repoId: 'repo-1',
      phaseId: 'plan-design',
      startCommitSha: 'sha',
    });

    const ev = events.find(e => e.type === 'phase.fallback.escalated')!;
    expect(ev.message).toContain(`"${logLine}"`);
    expect(ev.metadata.triggerReason).toBe('quota_exceeded');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('handles non-JSON quota pattern match', async () => {
    const logLine = 'Usage limit reached';
    const { router, events, tmp } = setup(logLine);

    await router.invoke({
      profile: AgentProfileName('primary'),
      promptPath: join(tmp, 'prompt.md'),
      expectedArtifacts: [],
      cwd: tmp,
      runId: 'run-1',
      repoId: 'repo-1',
      phaseId: 'plan-design',
      startCommitSha: 'sha',
    });

    const ev = events.find(e => e.type === 'phase.fallback.escalated')!;
    expect(ev.message).toContain(`"${logLine}"`);
    expect(ev.metadata.triggerReason).toBe('quota_exceeded');

    rmSync(tmp, { recursive: true, force: true });
  });
});
