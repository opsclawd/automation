import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentProfileName } from '@ai-sdlc/domain';
import { CodexAgentAdapter } from '../codex-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dirs: string[] = [];

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-test-'));
  dirs.push(dir);
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@test', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'x');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}

afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});

const FIXTURES = join(__dirname, '..', '__fixtures__');

function req(cwd: string, overrides = {}) {
  return {
    profile: AgentProfileName('codex-reviewer'),
    promptPath: join(cwd, 'README.md'),
    expectedArtifacts: [],
    cwd,
    runId: '00000000-0000-0000-0000-000000000001',
    repoId: 'r',
    phaseId: 'spec-review',
    startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    model: 'default',
    ...overrides,
  };
}

describe('CodexAgentAdapter', () => {
  it('returns success and extracts transcript from JSONL output', async () => {
    const cwd = makeWorktree();
    const adapter = new CodexAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-codex-json-success.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('success');
    expect(result.runtime).toBe('codex');
    const transcript = readFileSync(result.stdoutPath, 'utf-8');
    expect(transcript).toBe('Review findings: LGTM, no issues found.');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('classifies quota error from JSONL and ignores false-positives in prose', async () => {
    const cwd = makeWorktree();
    const adapter = new CodexAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-codex-json-quota.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('failed');
    expect(readFileSync(result.stderrPath, 'utf-8')).toMatch(/^QUOTA_EXCEEDED:/);
  });

  it('ignores false-positive error strings in transcript text', async () => {
    const cwd = makeWorktree();
    const adapter = new CodexAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-codex-json-false-positive.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('success');
    const transcript = readFileSync(result.stdoutPath, 'utf-8');
    expect(transcript).toContain('Usage limit reached');
    // Ensure the stderr doesn't have the QUOTA_EXCEEDED marker that runExternalCli's
    // regex scanning would have added if it wasn't skipped.
    expect(readFileSync(result.stderrPath, 'utf-8')).not.toContain('QUOTA_EXCEEDED');
  });

  it('classifies 5xx errors as PROVIDER_ERROR', async () => {
    const cwd = makeWorktree();
    const adapter = new CodexAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-codex-json-provider-error.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('failed');
    expect(readFileSync(result.stderrPath, 'utf-8')).toMatch(/^PROVIDER_ERROR:/);
  });

  it('always runs in workspace-write sandbox', async () => {
    const cwd = makeWorktree();
    const argLog = join(cwd, 'args.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new CodexAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).toContain('exec');
    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
    expect(args).toContain('--json');
  });

  it('passes --add-dir for git metadata when running in a git worktree', async () => {
    const mainRepo = makeWorktree();
    const worktreeDir = join(mainRepo, 'worktree-1');
    execSync(`git worktree add -b wt-branch "${worktreeDir}" HEAD`, { cwd: mainRepo });
    dirs.push(worktreeDir);

    const argLog = join(worktreeDir, 'args.txt');
    const shim = join(worktreeDir, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);

    const adapter = new CodexAgentAdapter({ binaryPath: shim, artifactsDir: worktreeDir });
    await adapter.invoke(req(worktreeDir));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).toContain('--add-dir');
    expect(args).toContain(join(mainRepo, '.git', 'worktrees', 'worktree-1'));
    expect(args).toContain(join(mainRepo, '.git'));
  });

  it('passes --color never for clean parseable output', async () => {
    const cwd = makeWorktree();
    const argLog = join(cwd, 'args.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new CodexAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).toContain('--color');
    expect(args).toContain('never');
  });

  it('appends --model only when model is not "default"', async () => {
    const cwd = makeWorktree();
    const argLog = join(cwd, 'args.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new CodexAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd, { model: 'gpt-5' }));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5');
  });

  it('omits --model when model is "default"', async () => {
    const cwd = makeWorktree();
    const argLog = join(cwd, 'args.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new CodexAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd, { model: 'default' }));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).not.toContain('--model');
  });

  it('propagates provider field from request through adapter to result', async () => {
    const cwd = makeWorktree();
    const adapter = new CodexAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-codex-json-success.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke(req(cwd, { provider: 'openai' }));
    expect(result.provider).toBe('openai');
  });

  it('marks cancellation via AbortController as failed/cancelled_by_orchestrator', async () => {
    const cwd = makeWorktree();
    const adapter = new CodexAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-codex-slow.sh'),
      artifactsDir: cwd,
    });
    const controller = new AbortController();
    const p = adapter.invoke(req(cwd, { abortSignal: controller.signal }));
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const r = await p;
    expect(r.outcome).toBe('failed');
    expect(r.contractViolations).toContain('cancelled_by_orchestrator');
    expect(r.endCommitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports the inspected Codex event-stream path without fabricating usage when turn.completed is absent', async () => {
    const cwd = makeWorktree();
    const shim = join(cwd, 'fake-codex-no-turn-completed.sh');
    writeFileSync(
      shim,
      `#!/usr/bin/env bash\nset -euo pipefail\necho '{"type":"thread.started"}'\necho '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Review findings: LGTM, no issues found."}}'\nexit 0\n`,
    );
    execSync(`chmod +x ${shim}`);
    const adapter = new CodexAgentAdapter({
      binaryPath: shim,
      artifactsDir: cwd,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('success');
    expect(result.usage).toBeUndefined();
    expect(result.usageSourcePaths).toEqual([`${result.stdoutPath}.events.jsonl`]);
    expect(readFileSync(result.usageSourcePaths![0], 'utf-8')).toContain('thread.started');
    expect(readFileSync(result.stdoutPath, 'utf-8')).toBe(
      'Review findings: LGTM, no issues found.',
    );
  });

  it('assigns usage from turn.completed without accumulating other event usage', async () => {
    const cwd = makeWorktree();
    const shim = join(cwd, 'fake-codex-repeated-usage.sh');
    writeFileSync(
      shim,
      `#!/usr/bin/env bash\nset -euo pipefail\necho '{"type":"thread.started"}'\necho '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Review findings: LGTM."},"usage":{"input_tokens":20,"output_tokens":10}}'\necho '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}'\nexit 0\n`,
    );
    execSync(`chmod +x ${shim}`);
    const adapter = new CodexAgentAdapter({
      binaryPath: shim,
      artifactsDir: cwd,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('success');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(result.usageSourcePaths).toEqual([`${result.stdoutPath}.events.jsonl`]);
    expect(readFileSync(result.usageSourcePaths![0], 'utf-8')).toContain('turn.completed');
  });

  it('reads cache and reasoning tokens from their real field names (#943)', async () => {
    // Verified live against codex-cli 0.149.0: turn.completed's usage object
    // uses cached_input_tokens and reasoning_output_tokens, not
    // cache_read_tokens / reasoning_tokens — the old names silently matched
    // nothing, which is why cached_tokens was NULL on every existing row.
    const cwd = makeWorktree();
    const shim = join(cwd, 'fake-codex-real-field-names.sh');
    writeFileSync(
      shim,
      `#!/usr/bin/env bash\nset -euo pipefail\necho '{"type":"turn.completed","usage":{"input_tokens":45696,"cached_input_tokens":28160,"cache_write_input_tokens":0,"output_tokens":127,"reasoning_output_tokens":41}}'\nexit 0\n`,
    );
    execSync(`chmod +x ${shim}`);
    const adapter = new CodexAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    const result = await adapter.invoke(req(cwd));
    expect(result.usage).toEqual({
      inputTokens: 45696,
      outputTokens: 127,
      reasoningTokens: 41,
      cachedTokens: 28160,
    });
  });

  it('falls back to the old cache_read_tokens/reasoning_tokens field names if an older codex build emits them', async () => {
    const cwd = makeWorktree();
    const shim = join(cwd, 'fake-codex-legacy-field-names.sh');
    writeFileSync(
      shim,
      `#!/usr/bin/env bash\nset -euo pipefail\necho '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50,"reasoning_tokens":5,"cache_read_tokens":30}}'\nexit 0\n`,
    );
    execSync(`chmod +x ${shim}`);
    const adapter = new CodexAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    const result = await adapter.invoke(req(cwd));
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 5,
      cachedTokens: 30,
    });
  });
});
