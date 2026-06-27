import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { AgentProfileName } from '@ai-sdlc/domain';
import { AntigravityAgentAdapter } from '../antigravity-adapter.js';

const dirs: string[] = [];

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-test-'));
  dirs.push(dir);
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@test', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'x');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}

const FIXTURES = join(__dirname, '..', '__fixtures__');

function req(cwd: string, overrides = {}) {
  return {
    profile: AgentProfileName('antigravity-reviewer'),
    promptPath: join(cwd, 'README.md'),
    expectedArtifacts: [],
    cwd,
    runId: '00000000-0000-0000-0000-000000000001',
    repoId: 'r',
    phaseId: 'whole-pr-review',
    startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    model: 'default',
    ...overrides,
  };
}

afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe('AntigravityAgentAdapter', () => {
  it('returns success and runtime "antigravity" for a 0-exit child', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-success.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('success');
    expect(result.runtime).toBe('antigravity');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(result.stdoutPath, 'utf-8')).toContain('fake agy success');
    expect(result.endCommitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns failed outcome for non-zero exit', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-fail.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('failed');
    expect(r.exitCode).toBe(5);
  });

  it('passes the prompt via --print and stdin', async () => {
    const cwd = makeWorktree();
    const logDir = mkdtempSync(join(tmpdir(), 'agy-log-'));
    try {
      const adapter = new AntigravityAgentAdapter({
        binaryPath: join(FIXTURES, 'fake-agy-args-logger.sh'),
        artifactsDir: cwd,
        env: { AGY_LOG_DIR: logDir },
      });
      const promptPath = join(cwd, 'prompt.md');
      writeFileSync(promptPath, 'REVIEW THIS PR DIFF');
      await adapter.invoke(req(cwd, { promptPath }));
      const args = readFileSync(join(logDir, 'agy-last-args.txt'), 'utf-8');
      const stdin = readFileSync(join(logDir, 'agy-last-stdin.txt'), 'utf-8');
      expect(args).toContain('--print');
      expect(args).not.toContain('REVIEW THIS PR DIFF');
      expect(stdin).toBe('REVIEW THIS PR DIFF');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('includes --dangerously-skip-permissions in args', async () => {
    const cwd = makeWorktree();
    const logDir = mkdtempSync(join(tmpdir(), 'agy-log-'));
    try {
      const adapter = new AntigravityAgentAdapter({
        binaryPath: join(FIXTURES, 'fake-agy-args-logger.sh'),
        artifactsDir: cwd,
        env: { AGY_LOG_DIR: logDir },
      });
      await adapter.invoke(req(cwd));
      const args = readFileSync(join(logDir, 'agy-last-args.txt'), 'utf-8');
      expect(args).toContain('--dangerously-skip-permissions');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('registers the worktree as a workspace via --add-dir <cwd>', async () => {
    const cwd = makeWorktree();
    const logDir = mkdtempSync(join(tmpdir(), 'agy-log-'));
    try {
      const adapter = new AntigravityAgentAdapter({
        binaryPath: join(FIXTURES, 'fake-agy-args-logger.sh'),
        artifactsDir: cwd,
        env: { AGY_LOG_DIR: logDir },
      });
      await adapter.invoke(req(cwd));
      const args = readFileSync(join(logDir, 'agy-last-args.txt'), 'utf-8');
      expect(args).toContain('--add-dir');
      expect(args).toContain(cwd);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('marks cancellation via AbortController as failed/cancelled_by_orchestrator', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-slow.sh'),
      artifactsDir: cwd,
    });
    const controller = new AbortController();
    const p = adapter.invoke(req(cwd, { abortSignal: controller.signal }));
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const r = await p;
    expect(r.outcome).toBe('failed');
    expect(r.contractViolations).toContain('cancelled_by_orchestrator');
  });

  it('returns timeout outcome when child exceeds timeoutMsDefault', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-slow.sh'),
      artifactsDir: cwd,
      timeoutMsDefault: 50,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('timeout');
  });

  it('force-kills a SIGTERM-ignoring child within grace period', { timeout: 15_000 }, async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-hang.sh'),
      artifactsDir: cwd,
      timeoutMsDefault: 200,
    });
    const start = Date.now();
    const r = await adapter.invoke(req(cwd));
    const elapsed = Date.now() - start;
    expect(r.outcome).toBe('timeout');
    expect(elapsed).toBeGreaterThan(4_000);
    expect(elapsed).toBeLessThan(10_000);
  });

  it('detects provider error in stderr when process exits 0', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-provider-error.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('failed');
    expect(r.contractViolations).toContain('provider_error');
    expect(readFileSync(r.stderrPath, 'utf-8')).toContain('QUOTA_EXCEEDED');
    expect(r.exitCode).toBe(0);
  });

  it('does not mistakenly classify provider error text in stdout as provider_error', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-provider-error-stdout-only.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('success');
    expect(r.contractViolations).not.toContain('provider_error');
  });

  it('detects provider error in stderr when process exits nonzero', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-nonzero-provider-error.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('failed');
    expect(r.contractViolations).toContain('provider_error');
    expect(readFileSync(r.stderrPath, 'utf-8')).toContain('PROVIDER_ERROR');
    expect(r.exitCode).toBe(1);
  });

  it('detects silent zero-exit as contract_violation with no_output', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-silent-zero.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('contract_violation');
    expect(r.contractViolations).toContain('no_output');
    expect(r.exitCode).toBe(0);
    expect(readFileSync(r.stdoutPath, 'utf-8')).toBe('');
  });

  it('treats whitespace-only output as contract_violation with no_output', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-whitespace-only.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('contract_violation');
    expect(r.contractViolations).toContain('no_output');
    expect(r.exitCode).toBe(0);
    expect(readFileSync(r.stdoutPath, 'utf-8').trim()).toBe('');
  });

  it('skips no_output check for artifact-only phases with expectedArtifacts', async () => {
    const cwd = makeWorktree();
    writeFileSync(join(cwd, 'result.md'), 'ok');
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-silent-zero.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd, { expectedArtifacts: ['result.md'] }));
    expect(r.outcome).toBe('success');
    expect(r.contractViolations).not.toContain('no_output');
  });

  it('persists NO_OUTPUT diagnostic in stderr.log', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-silent-zero.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('contract_violation');
    expect(readFileSync(r.stderrPath, 'utf-8')).toContain('NO_OUTPUT');
  });

  it('clears stale files from scratch dir before invocation', async () => {
    const cwd = makeWorktree();
    const scratchDir = mkdtempSync(join(tmpdir(), 'agy-scratch-'));
    dirs.push(scratchDir);
    writeFileSync(join(scratchDir, 'stale-issue.md'), 'old content');
    writeFileSync(join(scratchDir, 'design.md'), 'old design');
    mkdirSync(join(scratchDir, 'nested'));
    writeFileSync(join(scratchDir, 'nested', 'data.json'), '{}');

    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-success.sh'),
      artifactsDir: cwd,
      scratchDir,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('success');

    // Scratch dir itself should still exist (we clear contents, not the dir)
    expect(existsSync(scratchDir)).toBe(true);

    // All stale files should be gone
    const remaining = readdirSync(scratchDir);
    expect(remaining.length).toBe(0);
  });

  it('does not throw when scratch dir does not exist', async () => {
    const cwd = makeWorktree();
    const nonExistent = join(tmpdir(), 'agy-scratch-nonexistent');
    // Ensure it does not exist
    try {
      rmSync(nonExistent, { recursive: true, force: true });
    } catch {}

    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-success.sh'),
      artifactsDir: cwd,
      scratchDir: nonExistent,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('success');
    // No error thrown — clearDirectory is a no-op for non-existent dirs
  });

  it('detects expected artifacts in scratch dir and recovers them to cwd', async () => {
    const cwd = makeWorktree();
    const scratchDir = mkdtempSync(join(tmpdir(), 'agy-scratch-'));
    dirs.push(scratchDir);

    // Create a custom fake agy script that writes the artifact to scratchDir during invocation
    const fakeScript = join(cwd, 'fake-agy-write-scratch.sh');
    writeFileSync(
      fakeScript,
      `#!/usr/bin/env bash
mkdir -p "${scratchDir}/automation"
printf "## Recovered design" > "${scratchDir}/automation/design.md"
echo "fake agy success"
exit 0
`,
      { mode: 0o755 }, // Make it executable
    );

    const adapter = new AntigravityAgentAdapter({
      binaryPath: fakeScript,
      artifactsDir: cwd,
      scratchDir,
    });
    // fakeScript exits 0 but never writes design.md to cwd.
    // runExternalCli will detect MISSING_REQUIRED_ARTIFACT and set
    // outcome=contract_violation. The adapter's post-invocation hook
    // should then find design.md in scratchDir, move it to cwd, and
    // change outcome to success.
    const result = await adapter.invoke(req(cwd, { expectedArtifacts: ['design.md'] }));

    // Outcome is success because the artifact was recovered
    expect(result.outcome).toBe('success');

    // Diagnostic violation code is present
    expect(result.contractViolations).toContain('artifact_in_scratch_dir');

    // The artifact was recovered to cwd
    expect(existsSync(join(cwd, 'design.md'))).toBe(true);
    expect(readFileSync(join(cwd, 'design.md'), 'utf-8')).toBe('## Recovered design');

    // remediatedArtifacts is populated
    expect(result.remediatedArtifacts).toBeDefined();
    expect(result.remediatedArtifacts!.length).toBe(1);
    expect(result.remediatedArtifacts![0]!.artifact).toBe('design.md');

    // The artifact is no longer in scratch dir (it was moved)
    expect(existsSync(join(scratchDir, 'automation', 'design.md'))).toBe(false);
  });

  it('does not recover when scratch dir has no matching expected artifacts', async () => {
    const cwd = makeWorktree();
    const scratchDir = mkdtempSync(join(tmpdir(), 'agy-scratch-'));
    dirs.push(scratchDir);
    writeFileSync(join(scratchDir, 'unrelated.log'), 'some log');

    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-success.sh'),
      artifactsDir: cwd,
      scratchDir,
    });
    const result = await adapter.invoke(req(cwd, { expectedArtifacts: ['design.md'] }));

    // The artifact is genuinely missing — no recovery possible
    expect(result.outcome).toBe('contract_violation');
    expect(result.contractViolations).toContain('missing_required_artifact');
    expect(result.contractViolations).not.toContain('artifact_in_scratch_dir');
    expect(result.remediatedArtifacts).toBeUndefined();
  });

  it('partially recovers some artifacts but fails with contract_violation if others are still missing', async () => {
    const cwd = makeWorktree();
    const scratchDir = mkdtempSync(join(tmpdir(), 'agy-scratch-'));
    dirs.push(scratchDir);

    // Create a custom fake agy script that writes one of the expected artifacts to scratchDir
    const fakeScript = join(cwd, 'fake-agy-write-partial.sh');
    writeFileSync(
      fakeScript,
      `#!/usr/bin/env bash
mkdir -p "${scratchDir}"
printf "## Recovered design" > "${scratchDir}/design.md"
echo "fake agy success"
exit 0
`,
      { mode: 0o755 },
    );

    const adapter = new AntigravityAgentAdapter({
      binaryPath: fakeScript,
      artifactsDir: cwd,
      scratchDir,
    });

    // We expect both design.md and other.md. Only design.md is in scratchDir.
    const result = await adapter.invoke(req(cwd, { expectedArtifacts: ['design.md', 'other.md'] }));

    // The invocation should still fail because other.md is missing
    expect(result.outcome).toBe('contract_violation');

    // Both missing_required_artifact and artifact_in_scratch_dir should be present
    expect(result.contractViolations).toContain('missing_required_artifact');
    expect(result.contractViolations).toContain('artifact_in_scratch_dir');

    // design.md should still be successfully recovered to cwd
    expect(existsSync(join(cwd, 'design.md'))).toBe(true);
    expect(readFileSync(join(cwd, 'design.md'), 'utf-8')).toBe('## Recovered design');

    // other.md should be missing
    expect(existsSync(join(cwd, 'other.md'))).toBe(false);

    // remediatedArtifacts should be populated with the recovered design.md
    expect(result.remediatedArtifacts).toBeDefined();
    expect(result.remediatedArtifacts!.length).toBe(1);
    expect(result.remediatedArtifacts![0]!.artifact).toBe('design.md');
  });
});
