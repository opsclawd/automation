import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { AgentProfileName } from '@ai-sdlc/domain';
import { AntigravityAgentAdapter, validateScratchDir } from '../antigravity-adapter.js';

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

  it('passes the prompt via --print as a positional argument', async () => {
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
      expect(args).toContain('REVIEW THIS PR DIFF');
      expect(stdin).toBe('');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('includes --dangerously-skip-permissions in args', async () => {
    // Load-bearing, not incidental: without it, any tool-using prompt blocks
    // waiting for interactive permission approval that can never arrive in
    // this headless context, and the process hangs until timeout kills it
    // (verified directly against the live agy binary — see #713 review).
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

  it('passes --print-timeout derived from request.timeoutMs (effective per-invocation timeout)', async () => {
    const cwd = makeWorktree();
    const logDir = mkdtempSync(join(tmpdir(), 'agy-log-'));
    try {
      const adapter = new AntigravityAgentAdapter({
        binaryPath: join(FIXTURES, 'fake-agy-args-logger.sh'),
        artifactsDir: cwd,
        env: { AGY_LOG_DIR: logDir },
      });
      await adapter.invoke(req(cwd, { timeoutMs: 10 * 60 * 1000 })); // 10 minutes → expect 9m
      const args = readFileSync(join(logDir, 'agy-last-args.txt'), 'utf-8');
      expect(args).toContain('--print-timeout');
      expect(args).toContain('9m');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('falls back --print-timeout to timeoutMsDefault when request.timeoutMs is absent', async () => {
    const cwd = makeWorktree();
    const logDir = mkdtempSync(join(tmpdir(), 'agy-log-'));
    try {
      const adapter = new AntigravityAgentAdapter({
        binaryPath: join(FIXTURES, 'fake-agy-args-logger.sh'),
        artifactsDir: cwd,
        timeoutMsDefault: 20 * 60 * 1000, // 20 minutes → expect 19m
        env: { AGY_LOG_DIR: logDir },
      });
      await adapter.invoke(req(cwd)); // no timeoutMs on request
      const args = readFileSync(join(logDir, 'agy-last-args.txt'), 'utf-8');
      expect(args).toContain('--print-timeout');
      expect(args).toContain('19m');
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
    const result = await adapter.invoke(req(cwd, { expectedArtifacts: ['design.md'] }));

    expect(result.outcome).toBe('success');
    expect(result.contractViolations).toContain('artifact_in_scratch_dir');
    expect(existsSync(join(cwd, 'design.md'))).toBe(true);
    expect(readFileSync(join(cwd, 'design.md'), 'utf-8')).toBe('## Recovered design');
    expect(result.remediatedArtifacts).toBeDefined();
    expect(result.remediatedArtifacts!.length).toBe(1);
    expect(result.remediatedArtifacts![0]!.artifact).toBe('design.md');
    expect(existsSync(join(scratchDir, 'design.md'))).toBe(false);
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

    const fakeScript = join(cwd, 'fake-agy-write-partial.sh');
    writeFileSync(
      fakeScript,
      `#!/usr/bin/env bash
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

  it('recovers expected artifacts in a subdirectory under scratch dir preserving the relative path', async () => {
    const cwd = makeWorktree();
    const scratchDir = mkdtempSync(join(tmpdir(), 'agy-scratch-'));
    dirs.push(scratchDir);

    const fakeScript = join(cwd, 'fake-agy-write-sub.sh');
    writeFileSync(
      fakeScript,
      `#!/usr/bin/env bash
mkdir -p "${scratchDir}/docs"
printf "## Sub design" > "${scratchDir}/docs/design.md"
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
    const result = await adapter.invoke(req(cwd, { expectedArtifacts: ['docs/design.md'] }));

    expect(result.outcome).toBe('success');
    expect(result.contractViolations).toContain('artifact_in_scratch_dir');
    expect(existsSync(join(cwd, 'docs/design.md'))).toBe(true);
    expect(readFileSync(join(cwd, 'docs/design.md'), 'utf-8')).toBe('## Sub design');
    expect(result.remediatedArtifacts).toBeDefined();
    expect(result.remediatedArtifacts!.length).toBe(1);
    expect(result.remediatedArtifacts![0]!.artifact).toBe('docs/design.md');
    expect(existsSync(join(scratchDir, 'docs/design.md'))).toBe(false);
  });

  it('throws when scratchDir resolves to root temp or .gemini directory', () => {
    // Test for tmpdir root
    expect(() => validateScratchDir(tmpdir())).toThrow('Unsafe scratch directory path');

    // Test for .gemini root
    expect(() => validateScratchDir(join(homedir(), '.gemini'))).toThrow(
      'Unsafe scratch directory path',
    );

    // Test for homedir
    expect(() => validateScratchDir(homedir())).toThrow('Unsafe scratch directory path');

    // Test for /
    expect(() => validateScratchDir('/')).toThrow('Unsafe scratch directory path');
  });

  it('only recovers artifacts matching exact relative path and ignores basename collisions', async () => {
    const cwd = makeWorktree();
    const scratchDir = mkdtempSync(join(tmpdir(), 'agy-scratch-'));
    dirs.push(scratchDir);

    const fakeScript = join(cwd, 'fake-agy-collision.sh');
    writeFileSync(
      fakeScript,
      `#!/usr/bin/env bash
mkdir -p "${scratchDir}/node_modules/some-dep"
printf "{}" > "${scratchDir}/node_modules/some-dep/package.json"
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
    // Expected artifact is package.json at root level
    const result = await adapter.invoke(req(cwd, { expectedArtifacts: ['package.json'] }));

    // Should NOT recover node_modules/some-dep/package.json as package.json at root,
    // nor should it copy it to node_modules/some-dep/package.json in worktree.
    expect(result.outcome).toBe('contract_violation');
    expect(result.contractViolations).toContain('missing_required_artifact');
    expect(result.contractViolations).not.toContain('artifact_in_scratch_dir');
    expect(existsSync(join(cwd, 'package.json'))).toBe(false);
    expect(existsSync(join(cwd, 'node_modules/some-dep/package.json'))).toBe(false);
    expect(result.remediatedArtifacts).toBeUndefined();
  });

  it('appends to remediatedArtifacts instead of overwriting existing entries', async () => {
    const cwd = makeWorktree();
    const scratchDir = mkdtempSync(join(tmpdir(), 'agy-scratch-'));
    dirs.push(scratchDir);

    const fakeScript = join(cwd, 'fake-agy-append.sh');
    writeFileSync(
      fakeScript,
      `#!/usr/bin/env bash
mkdir -p "${cwd}/packages"
printf "## Misplaced design" > "${cwd}/packages/design.md"
printf "## Stray other" > "${scratchDir}/other.md"
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

    const result = await adapter.invoke(req(cwd, { expectedArtifacts: ['design.md', 'other.md'] }));

    expect(result.outcome).toBe('success');
    expect(result.remediatedArtifacts).toBeDefined();
    expect(result.remediatedArtifacts!.length).toBe(2);

    const artifacts = result.remediatedArtifacts!.map((r) => r.artifact);
    expect(artifacts).toContain('design.md');
    expect(artifacts).toContain('other.md');
  });

  it('still records ARTIFACT_IN_SCRATCH_DIR when recovery fails completely', async () => {
    const cwd = makeWorktree();
    const scratchDir = mkdtempSync(join(tmpdir(), 'agy-scratch-'));
    dirs.push(scratchDir);

    // Create a conflict: make design.md a file in cwd so dirname(cwd/design.md/stray.md) fails to mkdir
    writeFileSync(join(cwd, 'design.md'), 'conflict file');

    const fakeScript = join(cwd, 'fake-agy-fail-recovery.sh');
    writeFileSync(
      fakeScript,
      `#!/usr/bin/env bash
mkdir -p "${scratchDir}/design.md"
printf "## Stray" > "${scratchDir}/design.md/stray.md"
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

    const result = await adapter.invoke(req(cwd, { expectedArtifacts: ['design.md/stray.md'] }));

    // Should remain contract_violation because recovery failed (destination is blocked by the file)
    expect(result.outcome).toBe('contract_violation');
    expect(result.contractViolations).toContain('missing_required_artifact');

    // BUT should still record ARTIFACT_IN_SCRATCH_DIR because the file was found in scratch
    expect(result.contractViolations).toContain('artifact_in_scratch_dir');
    expect(result.remediatedArtifacts).toBeUndefined();
    expect(existsSync(join(cwd, 'design.md/stray.md'))).toBe(false);
  });

  // --- Brain-dir recovery tests (#530) ---
  // Helpers: tests create a tmpdir as brainRoot and pass it via adapter opts.
  // A "brain UUID dir" is one level of subdirectory under brainRoot.

  it('recovers artifact from brain dir when exactly one UUID dir has a matching file', async () => {
    const cwd = makeWorktree();
    const brainRoot = mkdtempSync(join(tmpdir(), 'agy-brain-'));
    dirs.push(brainRoot);
    const uuidDir = join(brainRoot, 'aaaaaaaa-bbbb-cccc-dddd-111111111111');
    mkdirSync(uuidDir, { recursive: true });
    writeFileSync(join(uuidDir, 'compound.md'), '# Learnings\n');

    // Fake agy exits 0 without writing compound.md to cwd → triggers MISSING_REQUIRED_ARTIFACT
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-success.sh'),
      artifactsDir: cwd,
      brainDir: brainRoot,
    });
    const result = await adapter.invoke(req(cwd, { expectedArtifacts: ['compound.md'] }));

    expect(result.outcome).toBe('success');
    expect(result.contractViolations).toContain('artifact_in_brain_dir');
    expect(existsSync(join(cwd, 'compound.md'))).toBe(true);
    expect(readFileSync(join(cwd, 'compound.md'), 'utf-8')).toBe('# Learnings\n');
    expect(result.remediatedArtifacts).toBeDefined();
    expect(result.remediatedArtifacts!.length).toBe(1);
    expect(result.remediatedArtifacts![0]!.artifact).toBe('compound.md');
    // Brain file is COPIED not moved — original must still exist
    expect(existsSync(join(uuidDir, 'compound.md'))).toBe(true);
  });

  it('does not recover from brain dir when zero UUID dirs have the expected artifact', async () => {
    const cwd = makeWorktree();
    const brainRoot = mkdtempSync(join(tmpdir(), 'agy-brain-empty-'));
    dirs.push(brainRoot);
    // brainRoot exists but has no UUID subdirs

    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-success.sh'),
      artifactsDir: cwd,
      brainDir: brainRoot,
    });
    const result = await adapter.invoke(req(cwd, { expectedArtifacts: ['compound.md'] }));

    expect(result.outcome).toBe('contract_violation');
    expect(result.contractViolations).toContain('missing_required_artifact');
    expect(result.contractViolations).not.toContain('artifact_in_brain_dir');
    expect(existsSync(join(cwd, 'compound.md'))).toBe(false);
  });

  it('fails to recover when multiple UUID dirs have the same basename (uniqueness guard)', async () => {
    const cwd = makeWorktree();
    const brainRoot = mkdtempSync(join(tmpdir(), 'agy-brain-multi-'));
    dirs.push(brainRoot);
    // Two UUID dirs both have compound.md
    const uuidDir1 = join(brainRoot, 'aaaaaaaa-bbbb-cccc-dddd-111111111111');
    const uuidDir2 = join(brainRoot, 'aaaaaaaa-bbbb-cccc-dddd-222222222222');
    mkdirSync(uuidDir1, { recursive: true });
    mkdirSync(uuidDir2, { recursive: true });

    const file1 = join(uuidDir1, 'compound.md');
    const file2 = join(uuidDir2, 'compound.md');

    writeFileSync(file1, '# Learnings session 1\n');
    writeFileSync(file2, '# Learnings session 2\n');

    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-success.sh'),
      artifactsDir: cwd,
      brainDir: brainRoot,
    });
    const result = await adapter.invoke(req(cwd, { expectedArtifacts: ['compound.md'] }));

    expect(result.outcome).toBe('contract_violation');
    expect(result.contractViolations).toContain('missing_required_artifact');
    expect(result.contractViolations).not.toContain('artifact_in_brain_dir');
    expect(existsSync(join(cwd, 'compound.md'))).toBe(false);
  });

  it('prioritizes the current session runId directory when multiple UUID dirs have the same basename', async () => {
    const cwd = makeWorktree();
    const brainRoot = mkdtempSync(join(tmpdir(), 'agy-brain-prioritize-'));
    dirs.push(brainRoot);

    const currentRunId = '00000000-0000-0000-0000-000000000001';
    const uuidDirCurrent = join(brainRoot, currentRunId);
    const uuidDirOther = join(brainRoot, 'aaaaaaaa-bbbb-cccc-dddd-222222222222');
    mkdirSync(uuidDirCurrent, { recursive: true });
    mkdirSync(uuidDirOther, { recursive: true });

    const fileCurrent = join(uuidDirCurrent, 'compound.md');
    const fileOther = join(uuidDirOther, 'compound.md');

    // Make the other file newer, but current should still be prioritized
    writeFileSync(fileCurrent, '# Current run learnings\n');
    writeFileSync(fileOther, '# Other run learnings\n');

    // Set mtime of current file to be older
    const time = new Date();
    time.setSeconds(time.getSeconds() - 10);
    utimesSync(fileCurrent, time, time);

    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-success.sh'),
      artifactsDir: cwd,
      brainDir: brainRoot,
    });
    const result = await adapter.invoke(
      req(cwd, { expectedArtifacts: ['compound.md'], runId: currentRunId }),
    );

    expect(result.outcome).toBe('success');
    expect(result.contractViolations).toContain('artifact_in_brain_dir');
    expect(existsSync(join(cwd, 'compound.md'))).toBe(true);
    expect(readFileSync(join(cwd, 'compound.md'), 'utf-8')).toBe('# Current run learnings\n');
  });

  it('brain recovery fires after scratch recovery when scratch has no match', async () => {
    const cwd = makeWorktree();
    const scratchDir = mkdtempSync(join(tmpdir(), 'agy-scratch-seq-'));
    dirs.push(scratchDir);
    const brainRoot = mkdtempSync(join(tmpdir(), 'agy-brain-seq-'));
    dirs.push(brainRoot);
    // Scratch has an unrelated file; brain has the expected artifact
    writeFileSync(join(scratchDir, 'unrelated.log'), 'log data');
    const uuidDir = join(brainRoot, 'aaaaaaaa-bbbb-cccc-dddd-333333333333');
    mkdirSync(uuidDir, { recursive: true });
    writeFileSync(join(uuidDir, 'compound.md'), '# Learnings from brain\n');

    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-success.sh'),
      artifactsDir: cwd,
      scratchDir,
      brainDir: brainRoot,
    });
    const result = await adapter.invoke(req(cwd, { expectedArtifacts: ['compound.md'] }));

    // Scratch miss → brain fires → success
    expect(result.outcome).toBe('success');
    expect(result.contractViolations).toContain('artifact_in_brain_dir');
    expect(result.contractViolations).not.toContain('artifact_in_scratch_dir');
    expect(existsSync(join(cwd, 'compound.md'))).toBe(true);
    expect(readFileSync(join(cwd, 'compound.md'), 'utf-8')).toBe('# Learnings from brain\n');
  });

  it('ignores invalid runId path traversal attempts during brain recovery', async () => {
    const cwd = makeWorktree();
    const brainRoot = mkdtempSync(join(tmpdir(), 'agy-brain-traversal-'));
    dirs.push(brainRoot);

    // Create a file outside the brainRoot that we will attempt to access via path traversal
    const secretDir = mkdtempSync(join(tmpdir(), 'agy-secret-'));
    dirs.push(secretDir);
    const secretFile = join(secretDir, 'sensitive.txt');
    writeFileSync(secretFile, 'sensitive data');

    // runId is crafted as a relative path targeting the secret directory
    const traversalRunId = `../${secretDir.substring(secretDir.lastIndexOf('/') + 1)}`;

    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-success.sh'),
      artifactsDir: cwd,
      brainDir: brainRoot,
    });

    // We request sensitive.txt, which exists in secretDir, which is targetable if traversal succeeded.
    const result = await adapter.invoke(
      req(cwd, { expectedArtifacts: ['sensitive.txt'], runId: traversalRunId }),
    );

    // Should fail with contract_violation / missing_required_artifact because traversal was blocked
    expect(result.outcome).toBe('contract_violation');
    expect(result.contractViolations).toContain('missing_required_artifact');
    expect(result.contractViolations).not.toContain('artifact_in_brain_dir');
    expect(existsSync(join(cwd, 'sensitive.txt'))).toBe(false);
  });

  it('fallback scan sorts by mtime descending and limits search to the 1000 most recent runs', async () => {
    const cwd = makeWorktree();
    const brainRoot = mkdtempSync(join(tmpdir(), 'agy-brain-limit-'));
    dirs.push(brainRoot);

    // Create 1005 directories.
    // 5 old ones (with the artifact)
    // 1000 newer ones (without the artifact)
    // The fallback scan should not find the artifact because the 1000 most recent directories
    // do not contain the artifact, and the 5 older ones with the artifact are excluded.

    const oldDirs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = join(brainRoot, `old-run-${i}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'compound.md'), `# Old learnings ${i}\n`);
      oldDirs.push(d);
    }

    const newDirs: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const d = join(brainRoot, `new-run-${i}`);
      mkdirSync(d, { recursive: true });
      newDirs.push(d);
    }

    // Set modification times to ensure old runs are older than new runs
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const time = new Date(now - 100000 - i * 1000);
      utimesSync(oldDirs[i], time, time);
    }
    for (let i = 0; i < 1000; i++) {
      const time = new Date(now - i * 10);
      utimesSync(newDirs[i], time, time);
    }

    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-success.sh'),
      artifactsDir: cwd,
      brainDir: brainRoot,
    });

    const result = await adapter.invoke(req(cwd, { expectedArtifacts: ['compound.md'] }));

    // Should fail with contract_violation / missing_required_artifact because the artifact
    // is only present in the old runs, which were excluded since we only check the 1000 most recent.
    expect(result.outcome).toBe('contract_violation');
    expect(result.contractViolations).toContain('missing_required_artifact');
    expect(result.contractViolations).not.toContain('artifact_in_brain_dir');
    expect(existsSync(join(cwd, 'compound.md'))).toBe(false);
  });

  it('fallback scan finds artifact in new runs even when there are more than 1000 directories in total', async () => {
    const cwd = makeWorktree();
    const brainRoot = mkdtempSync(join(tmpdir(), 'agy-brain-find-recent-'));
    dirs.push(brainRoot);

    // Create 1005 directories:
    // 1000 older ones (without the artifact)
    // 5 newer ones (with the artifact)
    const oldDirs: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const d = join(brainRoot, `run-old-${String(i).padStart(4, '0')}`);
      mkdirSync(d, { recursive: true });
      oldDirs.push(d);
    }

    const newDirs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = join(brainRoot, `run-new-${i}`);
      mkdirSync(d, { recursive: true });
      if (i === 0) {
        writeFileSync(join(d, 'compound.md'), `# New learnings ${i}\n`);
      }
      newDirs.push(d);
    }

    // Set modification times to ensure new runs are newer than old runs
    const now = Date.now();
    for (let i = 0; i < 1000; i++) {
      const time = new Date(now - 100000 - i * 10);
      utimesSync(oldDirs[i], time, time);
    }
    for (let i = 0; i < 5; i++) {
      const time = new Date(now - i * 10);
      utimesSync(newDirs[i], time, time);
    }

    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-success.sh'),
      artifactsDir: cwd,
      brainDir: brainRoot,
    });

    const result = await adapter.invoke(req(cwd, { expectedArtifacts: ['compound.md'] }));

    // Should succeed because the new runs containing the artifact are within the 1000 most recent
    expect(result.outcome).toBe('success');
    expect(result.contractViolations).toContain('artifact_in_brain_dir');
    expect(existsSync(join(cwd, 'compound.md'))).toBe(true);
    // Since we sort the found matches by file mtime descending as well, it should pick the most recent one (run-new-0)
    expect(readFileSync(join(cwd, 'compound.md'), 'utf-8')).toBe('# New learnings 0\n');
  });

  it('passes --model with the resolved label when request.model is a known slug', async () => {
    const cwd = makeWorktree();
    const logDir = mkdtempSync(join(tmpdir(), 'agy-log-'));
    try {
      const adapter = new AntigravityAgentAdapter({
        binaryPath: join(FIXTURES, 'fake-agy-args-logger.sh'),
        artifactsDir: cwd,
        env: { AGY_LOG_DIR: logDir },
      });
      await adapter.invoke(req(cwd, { model: 'gemini-3.5-flash-high' }));
      const args = readFileSync(join(logDir, 'agy-last-args.txt'), 'utf-8');
      const tokens = args.split(' ');
      expect(tokens).toContain('--model');
      expect(args).toContain('Gemini 3.5 Flash (High)');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('inserts --model between --print-timeout and --print', async () => {
    const cwd = makeWorktree();
    const logDir = mkdtempSync(join(tmpdir(), 'agy-log-'));
    try {
      const adapter = new AntigravityAgentAdapter({
        binaryPath: join(FIXTURES, 'fake-agy-args-logger.sh'),
        artifactsDir: cwd,
        env: { AGY_LOG_DIR: logDir },
      });
      await adapter.invoke(req(cwd, { model: 'gemini-3.5-flash-low' }));
      const args = readFileSync(join(logDir, 'agy-last-args.txt'), 'utf-8');
      // fake-agy-args-logger.sh writes `$@` (space-joined) — find the indices.
      // Use a leading space on '--print' so we don't match the '--print' inside '--print-timeout'.
      const tokens = args.split(' ');
      const timeoutIdx = tokens.indexOf('--print-timeout');
      const modelIdx = tokens.indexOf('--model');
      const printIdx = tokens.indexOf('--print');
      expect(timeoutIdx).toBeGreaterThanOrEqual(0);
      expect(modelIdx).toBeGreaterThan(timeoutIdx);
      expect(printIdx).toBeGreaterThan(modelIdx);
      expect(args).toContain('Gemini 3.5 Flash (Low)');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('throws ConfigError for unknown model slug', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-args-logger.sh'),
      artifactsDir: cwd,
    });
    await expect(adapter.invoke(req(cwd, { model: 'nonexistent-model' }))).rejects.toThrow(
      /unknown model 'nonexistent-model'/,
    );
  });

  it('omits --model when model is default', async () => {
    const cwd = makeWorktree();
    const logDir = mkdtempSync(join(tmpdir(), 'agy-log-'));
    try {
      const adapter = new AntigravityAgentAdapter({
        binaryPath: join(FIXTURES, 'fake-agy-args-logger.sh'),
        artifactsDir: cwd,
        env: { AGY_LOG_DIR: logDir },
      });
      await adapter.invoke(req(cwd, { model: 'default' }));
      const args = readFileSync(join(logDir, 'agy-last-args.txt'), 'utf-8');
      const tokens = args.split(' ');
      expect(tokens).not.toContain('--model');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('omits --model when model is undefined', async () => {
    const cwd = makeWorktree();
    const logDir = mkdtempSync(join(tmpdir(), 'agy-log-'));
    try {
      const adapter = new AntigravityAgentAdapter({
        binaryPath: join(FIXTURES, 'fake-agy-args-logger.sh'),
        artifactsDir: cwd,
        env: { AGY_LOG_DIR: logDir },
      });
      await adapter.invoke(req(cwd, { model: undefined }));
      const args = readFileSync(join(logDir, 'agy-last-args.txt'), 'utf-8');
      const tokens = args.split(' ');
      expect(tokens).not.toContain('--model');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('omits --model when model is empty string', async () => {
    const cwd = makeWorktree();
    const logDir = mkdtempSync(join(tmpdir(), 'agy-log-'));
    try {
      const adapter = new AntigravityAgentAdapter({
        binaryPath: join(FIXTURES, 'fake-agy-args-logger.sh'),
        artifactsDir: cwd,
        env: { AGY_LOG_DIR: logDir },
      });
      await adapter.invoke(req(cwd, { model: '' }));
      const args = readFileSync(join(logDir, 'agy-last-args.txt'), 'utf-8');
      const tokens = args.split(' ');
      expect(tokens).not.toContain('--model');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('receives prompt correctly in back-to-back invocations', async () => {
    const cwd = makeWorktree();
    const logDir = mkdtempSync(join(tmpdir(), 'agy-log-b2b-'));
    try {
      const adapter = new AntigravityAgentAdapter({
        binaryPath: join(FIXTURES, 'fake-agy-args-logger.sh'),
        artifactsDir: cwd,
        env: { AGY_LOG_DIR: logDir },
      });

      // First invocation
      const p1 = join(cwd, 'p1.md');
      writeFileSync(p1, 'PROMPT 1');
      await adapter.invoke(req(cwd, { promptPath: p1 }));
      expect(readFileSync(join(logDir, 'agy-last-args.txt'), 'utf-8')).toContain('PROMPT 1');

      // Second invocation (immediately after)
      const p2 = join(cwd, 'p2.md');
      writeFileSync(p2, 'PROMPT 2');
      await adapter.invoke(req(cwd, { promptPath: p2 }));
      expect(readFileSync(join(logDir, 'agy-last-args.txt'), 'utf-8')).toContain('PROMPT 2');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
