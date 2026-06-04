import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { AgentProfileName } from '@ai-sdlc/domain';
import { OpenCodeAgentAdapter } from '../opencode-adapter.js';

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-test-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@test', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'x');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSessionLogDir(
  artifactsDir: string,
  timeoutMs = 3000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = readdirSync(artifactsDir);
    const invDir = entries.find((d) => d.startsWith('inv-'));
    if (invDir) {
      const slDir = join(artifactsDir, invDir, 'session-log');
      if (existsSync(slDir)) return slDir;
    }
    await sleep(50);
  }
  return null;
}

describe('OpenCodeAgentAdapter', () => {
  it('returns success outcome for a 0-exit child', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-success.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    });
    expect(result.outcome).toBe('success');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(result.stdoutPath, 'utf-8')).toContain('fake opencode success');
    expect(readFileSync(result.stderrPath, 'utf-8')).toContain('no errors');
  });

  it('returns failed outcome for non-zero exit', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-fail.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    });
    expect(r.outcome).toBe('failed');
    expect(r.exitCode).toBe(7);
  });

  it('returns timeout outcome when child exceeds timeout', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-slow.sh'),
      artifactsDir: cwd,
      timeoutMsDefault: 500,
    });
    const r = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    });
    expect(r.outcome).toBe('timeout');
  }, 15000);

  it('terminates child on cancellation via AbortController', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-slow.sh'),
      artifactsDir: cwd,
    });
    const controller = new AbortController();
    const p = adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const r = await p;
    expect(r.outcome).toBe('failed');
    expect(r.contractViolations).toContain('cancelled_by_orchestrator');
  });

  it('passes --model to opencode when request.model is set', async () => {
    const cwd = makeWorktree();
    const argsLogFile = join(__dirname, '..', '__fixtures__', 'last-args.txt');
    if (existsSync(argsLogFile)) rmSync(argsLogFile);

    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-args-logger.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
      model: 'claude-opus-4.7',
    });
    expect(result.outcome).toBe('success');
    expect(result.model).toBe('claude-opus-4.7');
    const loggedArgs = readFileSync(argsLogFile, 'utf-8').trim();
    expect(loggedArgs).toContain('--model');
    expect(loggedArgs).toContain('claude-opus-4.7');
    expect(loggedArgs).not.toContain('--prompt-file');
    const stdinLogFile = join(__dirname, '..', '__fixtures__', 'last-stdin.txt');
    expect(readFileSync(stdinLogFile, 'utf-8')).toBe('');

    if (existsSync(argsLogFile)) rmSync(argsLogFile);
    if (existsSync(stdinLogFile)) rmSync(stdinLogFile);
  });

  it('composes --model as provider/model when both are set', async () => {
    const cwd = makeWorktree();
    const argsLogFile = join(__dirname, '..', '__fixtures__', 'last-args.txt');
    if (existsSync(argsLogFile)) rmSync(argsLogFile);

    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-args-logger.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
      provider: 'minimax-coding-plan',
      model: 'MiniMax-M2.7',
    });
    expect(result.outcome).toBe('success');
    expect(result.model).toBe('MiniMax-M2.7');
    const loggedArgs = readFileSync(argsLogFile, 'utf-8').trim();
    expect(loggedArgs).toContain('--model');
    expect(loggedArgs).toContain('minimax-coding-plan/MiniMax-M2.7');

    if (existsSync(argsLogFile)) rmSync(argsLogFile);
  });

  it('preserves slash-containing model IDs under the configured provider', async () => {
    // OpenRouter-style models contain a slash in the model name itself
    // (e.g. moonshotai/kimi-k2 under provider 'openrouter'). The adapter
    // must compose provider/model verbatim; config supplies the bare model
    // name without provider prefix.
    const cwd = makeWorktree();
    const argsLogFile = join(__dirname, '..', '__fixtures__', 'last-args.txt');
    if (existsSync(argsLogFile)) rmSync(argsLogFile);

    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-args-logger.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2',
    });
    expect(result.outcome).toBe('success');
    const loggedArgs = readFileSync(argsLogFile, 'utf-8').trim();
    expect(loggedArgs).toContain('--model');
    expect(loggedArgs).toContain('openrouter/moonshotai/kimi-k2');

    if (existsSync(argsLogFile)) rmSync(argsLogFile);
  });

  it('omits --model when request.model is not set', async () => {
    const cwd = makeWorktree();
    const argsLogFile = join(__dirname, '..', '__fixtures__', 'last-args.txt');
    if (existsSync(argsLogFile)) rmSync(argsLogFile);

    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-args-logger.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    });
    expect(result.outcome).toBe('success');
    expect(result.model).toBe('');
    const loggedArgs = readFileSync(argsLogFile, 'utf-8').trim();
    expect(loggedArgs).not.toContain('--model');
    expect(loggedArgs).not.toContain('--prompt-file');
    const stdinLogFile = join(__dirname, '..', '__fixtures__', 'last-stdin.txt');
    expect(readFileSync(stdinLogFile, 'utf-8')).toBe('');

    if (existsSync(argsLogFile)) rmSync(argsLogFile);
    if (existsSync(stdinLogFile)) rmSync(stdinLogFile);
  });

  it('pipes multi-line prompt content unmodified via stdin', async () => {
    const cwd = makeWorktree();
    const argsLogFile = join(__dirname, '..', '__fixtures__', 'last-args.txt');
    const stdinLogFile = join(__dirname, '..', '__fixtures__', 'last-stdin.txt');
    if (existsSync(argsLogFile)) rmSync(argsLogFile);
    if (existsSync(stdinLogFile)) rmSync(stdinLogFile);
    const promptContent = 'Line one\nLine two with "quotes" and $shell\n\nLine four\n';
    const promptFile = join(cwd, 'prompt.txt');
    writeFileSync(promptFile, promptContent);

    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-args-logger.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: promptFile,
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    });
    expect(result.outcome).toBe('success');
    const loggedArgs = readFileSync(argsLogFile, 'utf-8').trim();
    expect(loggedArgs).not.toContain('--prompt-file');
    expect(loggedArgs).not.toContain(promptFile);
    const capturedStdin = readFileSync(stdinLogFile, 'utf-8');
    expect(capturedStdin).toBe(promptContent);
    expect(capturedStdin).toContain('Line one');
    expect(capturedStdin).toContain('"quotes"');
    expect(capturedStdin).toContain('$shell');

    if (existsSync(argsLogFile)) rmSync(argsLogFile);
    if (existsSync(stdinLogFile)) rmSync(stdinLogFile);
  });

  it('handles prompts exceeding 150KB via stdin without E2BIG', async () => {
    const cwd = makeWorktree();
    const argsLogFile = join(__dirname, '..', '__fixtures__', 'last-args.txt');
    const stdinLogFile = join(__dirname, '..', '__fixtures__', 'last-stdin.txt');
    if (existsSync(argsLogFile)) rmSync(argsLogFile);
    if (existsSync(stdinLogFile)) rmSync(stdinLogFile);
    const promptContent = 'A'.repeat(160_000);
    const promptFile = join(cwd, 'large-prompt.txt');
    writeFileSync(promptFile, promptContent);

    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-args-logger.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: promptFile,
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    });
    expect(result.outcome).toBe('success');
    const capturedStdin = readFileSync(stdinLogFile, 'utf-8');
    expect(capturedStdin.length).toBe(160_000);
    expect(capturedStdin).toBe(promptContent);

    if (existsSync(argsLogFile)) rmSync(argsLogFile);
    if (existsSync(stdinLogFile)) rmSync(stdinLogFile);
  });

  it('kills child process on quota pattern in session log', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-slow.sh'),
      artifactsDir: cwd,
      quotaPollMs: 500,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const injectionPromise = new Promise<void>((resolve) => {
      timer = setTimeout(async () => {
        const slDir = await waitForSessionLogDir(cwd);
        if (slDir) {
          writeFileSync(
            join(slDir, '2026-05-28T225115.log'),
            'INFO  2026-05-28T22:51:15.000Z +0ms service=llm msg=normal\nERROR 2026-05-28T22:51:16.000Z +0ms service=llm Usage limit reached for 5 hour. Your limit will reset at 2026-05-29 07:10:54\n',
          );
        }
        resolve();
      }, 800);
    });

    try {
      const start = Date.now();
      const r = await adapter.invoke({
        profile: AgentProfileName('opencode-frontier'),
        promptPath: '/dev/null',
        expectedArtifacts: [],
        cwd,
        runId: '00000000-0000-0000-0000-000000000001',
        repoId: 'r',
        phaseId: 'plan-design',
        startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
      });
      const elapsed = Date.now() - start;

      expect(r.outcome).toBe('failed');
      expect(elapsed).toBeLessThan(10000);
      expect(r.contractViolations).toContain('provider_error');
      expect(readFileSync(r.stderrPath, 'utf-8')).toContain('QUOTA_EXCEEDED');
    } finally {
      clearTimeout(timer);
      await injectionPromise;
    }
  }, 15000);

  it('does not kill child when session log directory is empty', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-slow.sh'),
      artifactsDir: cwd,
      timeoutMsDefault: 500,
    });
    const r = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    });
    expect(r.outcome).toBe('timeout');
  }, 15000);

  it('does not kill child on quota-like strings in non-structural log content (Issue #182 regression)', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-slow.sh'),
      artifactsDir: cwd,
      quotaPollMs: 500,
      timeoutMsDefault: 3000,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const injectionPromise = new Promise<void>((resolve) => {
      timer = setTimeout(async () => {
        const slDir = await waitForSessionLogDir(cwd);
        if (slDir) {
          writeFileSync(
            join(slDir, '2026-05-28T225115.log'),
            "REVIEWER_PROVIDER_ERROR_PATTERNS='AI_APICallError|RESOURCE_EXHAUSTED|429|quota.*exceed'\n",
          );
        }
        resolve();
      }, 800);
    });
    try {
      const r = await adapter.invoke({
        profile: AgentProfileName('opencode-frontier'),
        promptPath: '/dev/null',
        expectedArtifacts: [],
        cwd,
        runId: '00000000-0000-0000-0000-000000000001',
        repoId: 'r',
        phaseId: 'plan-design',
        startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
      });
      expect(r.outcome).toBe('timeout');
      expect(readFileSync(r.stderrPath, 'utf-8')).not.toContain('QUOTA_EXCEEDED');
    } finally {
      clearTimeout(timer);
      await injectionPromise;
    }
  }, 15000);

  it('detects quota pattern appended to existing log file', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-slow.sh'),
      artifactsDir: cwd,
      quotaPollMs: 500,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const injectionPromise = new Promise<void>((resolve) => {
      timer = setTimeout(async () => {
        const slDir = await waitForSessionLogDir(cwd);
        if (slDir) {
          const logFile = join(slDir, '2026-05-28T230000.log');
          writeFileSync(logFile, 'Previous session content\nNothing relevant here\n');
          await sleep(600);
          writeFileSync(
            logFile,
            'ERROR 2026-05-28T23:00:02.000Z +0ms service=llm New: "statusCode": 429 Too Many Requests\n',
            { flag: 'a' },
          );
        }
        resolve();
      }, 800);
    });
    try {
      const r = await adapter.invoke({
        profile: AgentProfileName('opencode-frontier'),
        promptPath: '/dev/null',
        expectedArtifacts: [],
        cwd,
        runId: '00000000-0000-0000-0000-000000000001',
        repoId: 'r',
        phaseId: 'plan-design',
        startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
      });
      expect(r.outcome).toBe('failed');
      expect(readFileSync(r.stderrPath, 'utf-8')).toContain('QUOTA_EXCEEDED');
    } finally {
      clearTimeout(timer);
      await injectionPromise;
    }
  }, 15000);

  it('detects provider error in stderr when process exits 0', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-provider-error.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    });
    expect(r.outcome).toBe('failed');
    expect(r.contractViolations).toContain('provider_error');
    expect(readFileSync(r.stderrPath, 'utf-8')).toContain('PROVIDER_ERROR');
    expect(r.exitCode).toBe(0);
  });

  it('does not mistakenly classify provider error text in stdout as provider_error', async () => {
    const cwd = makeWorktree();
    const startSha = execSync('git rev-parse HEAD', { cwd }).toString().trim();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(
        __dirname,
        '..',
        '__fixtures__',
        'fake-opencode-provider-error-stdout-only.sh',
      ),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'implement',
      startCommitSha: startSha,
    });
    expect(r.outcome).toBe('success');
    expect(r.contractViolations).not.toContain('provider_error');
  });

  it('detects no-op invocation with empty stdout and no git changes', async () => {
    const cwd = makeWorktree();
    const startSha = execSync('git rev-parse HEAD', { cwd }).toString().trim();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-noop.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'implement',
      startCommitSha: startSha,
    });
    expect(r.outcome).toBe('contract_violation');
    expect(r.contractViolations).toContain('no_output');
    expect(readFileSync(r.stderrPath, 'utf-8')).toContain('NO_OUTPUT');
  });

  it('detects no-op invocation with implement-task-N phaseId (real orchestrator format)', async () => {
    const cwd = makeWorktree();
    const startSha = execSync('git rev-parse HEAD', { cwd }).toString().trim();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-noop.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'implement-task-3',
      startCommitSha: startSha,
    });
    expect(r.outcome).toBe('contract_violation');
    expect(r.contractViolations).toContain('no_output');
  });

  it('does not trigger no-op heuristic when stdout is non-empty', async () => {
    const cwd = makeWorktree();
    const startSha = execSync('git rev-parse HEAD', { cwd }).toString().trim();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-success.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'implement',
      startCommitSha: startSha,
    });
    expect(r.outcome).toBe('success');
  });

  it('detects provider error in stderr when process exits nonzero', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-nonzero-provider-error.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    });
    expect(r.outcome).toBe('failed');
    expect(r.contractViolations).toContain('provider_error');
    expect(readFileSync(r.stderrPath, 'utf-8')).toContain('PROVIDER_ERROR');
    expect(r.exitCode).toBe(1);
  });

  it('detects crofai "Not Enough Credits" in session log post-exit (exit 0, clean stderr)', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(
        __dirname,
        '..',
        '__fixtures__',
        'fake-opencode-session-log-crofai-quota.sh',
      ),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'post-pr-review',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    });
    expect(r.outcome).toBe('failed');
    expect(r.exitCode).toBe(0);
    expect(readFileSync(r.stderrPath, 'utf-8')).toContain('QUOTA_EXCEEDED');
    expect(readFileSync(r.stderrPath, 'utf-8')).toContain('Not Enough Credits');
  });

  it('detects provider error in session log post-exit (exit 0, clean stderr)', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(
        __dirname,
        '..',
        '__fixtures__',
        'fake-opencode-session-log-provider-error.sh',
      ),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    });
    expect(r.outcome).toBe('failed');
    expect(r.exitCode).toBe(0);
    expect(r.contractViolations).toContain('provider_error');
    expect(readFileSync(r.stderrPath, 'utf-8')).toContain('PROVIDER_ERROR');
  });

  it('kills child process on provider error pattern in session log (watchdog)', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-slow.sh'),
      artifactsDir: cwd,
      quotaPollMs: 500,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const injectionPromise = new Promise<void>((resolve) => {
      timer = setTimeout(async () => {
        const slDir = await waitForSessionLogDir(cwd);
        if (slDir) {
          writeFileSync(
            join(slDir, '2026-06-03T120000.log'),
            'INFO  2026-06-03T12:00:00.000Z +0ms service=llm msg=normal\nERROR 2026-06-03T12:00:01.000Z +0ms service=llm {"name":"AI_APICallError","url":"https://crof.ai/v1/chat/completions","statusCode":500}\n',
          );
        }
        resolve();
      }, 800);
    });
    try {
      const start = Date.now();
      const r = await adapter.invoke({
        profile: AgentProfileName('opencode-frontier'),
        promptPath: '/dev/null',
        expectedArtifacts: [],
        cwd,
        runId: '00000000-0000-0000-0000-000000000001',
        repoId: 'r',
        phaseId: 'plan-design',
        startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
      });
      const elapsed = Date.now() - start;
      expect(r.outcome).toBe('failed');
      expect(elapsed).toBeLessThan(10000);
      expect(r.contractViolations).toContain('provider_error');
      expect(readFileSync(r.stderrPath, 'utf-8')).toContain('PROVIDER_ERROR');
    } finally {
      clearTimeout(timer);
      await injectionPromise;
    }
  }, 15000);

  it('does not kill child on normal log content in session log (no false positive)', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-slow.sh'),
      artifactsDir: cwd,
      quotaPollMs: 200,
      timeoutMsDefault: 2000,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const injectionPromise = new Promise<void>((resolve) => {
      timer = setTimeout(async () => {
        const slDir = await waitForSessionLogDir(cwd);
        if (slDir) {
          writeFileSync(
            join(slDir, '2026-06-03T120000.log'),
            'INFO  2026-06-03T12:00:00.000Z +0ms service=llm msg=normal operation\nINFO  2026-06-03T12:00:01.000Z +0ms service=llm msg=processing\n',
          );
        }
        resolve();
      }, 300);
    });
    try {
      const r = await adapter.invoke({
        profile: AgentProfileName('opencode-frontier'),
        promptPath: '/dev/null',
        expectedArtifacts: [],
        cwd,
        runId: '00000000-0000-0000-0000-000000000001',
        repoId: 'r',
        phaseId: 'plan-design',
        startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
      });
      expect(r.outcome).toBe('timeout');
      expect(r.contractViolations).not.toContain('provider_error');
      expect(readFileSync(r.stderrPath, 'utf-8')).not.toContain('PROVIDER_ERROR');
      expect(readFileSync(r.stderrPath, 'utf-8')).not.toContain('QUOTA_EXCEEDED');
    } finally {
      clearTimeout(timer);
      await injectionPromise;
    }
  }, 15000);

  it('handles multi-byte characters in session log content correctly (byte offset regression)', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-slow.sh'),
      artifactsDir: cwd,
      quotaPollMs: 500,
      timeoutMsDefault: 8000,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const injectionPromise = new Promise<void>((resolve) => {
      timer = setTimeout(async () => {
        const slDir = await waitForSessionLogDir(cwd);
        if (slDir) {
          const logFile = join(slDir, '2026-06-03T120000.log');
          writeFileSync(logFile, 'INFO 2026-06-03T11:59:00.000Z 你好世界 — résumé naïve café 🚀\n');
          await sleep(600);
          writeFileSync(
            logFile,
            'ERROR 2026-06-03T12:00:04.000Z +0ms service=llm {"error":{"code":401,"message":"Not Enough Credits","type":"unauthorized"}}\n',
            { flag: 'a' },
          );
        }
        resolve();
      }, 800);
    });
    try {
      const r = await adapter.invoke({
        profile: AgentProfileName('opencode-frontier'),
        promptPath: '/dev/null',
        expectedArtifacts: [],
        cwd,
        runId: '00000000-0000-0000-0000-000000000001',
        repoId: 'r',
        phaseId: 'post-pr-review',
        startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
      });
      expect(r.outcome).toBe('failed');
      expect(readFileSync(r.stderrPath, 'utf-8')).toContain('QUOTA_EXCEEDED');
      expect(readFileSync(r.stderrPath, 'utf-8')).toContain('Not Enough Credits');
    } finally {
      clearTimeout(timer);
      await injectionPromise;
    }
  }, 15000);
});
