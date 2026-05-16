import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBashScript } from '../run-bash-script.js';

function makeScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-sh-'));
  const path = join(dir, 'fake.sh');
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ai-orch-out-'));
}

describe('runBashScript', () => {
  it('captures stdout, stderr, combined, exit code, and duration', async () => {
    const out = tempDir();
    const script = makeScript('echo hello; echo oops 1>&2; exit 0');
    const res = await runBashScript({
      scriptPath: script,
      args: [],
      env: {},
      stdoutPath: join(out, 'stdout.log'),
      stderrPath: join(out, 'stderr.log'),
      combinedPath: join(out, 'combined.log'),
    });
    expect(res.exitCode).toBe(0);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(readFileSync(join(out, 'stdout.log'), 'utf8')).toContain('hello');
    expect(readFileSync(join(out, 'stderr.log'), 'utf8')).toContain('oops');
    const combined = readFileSync(join(out, 'combined.log'), 'utf8');
    expect(combined).toContain('hello');
    expect(combined).toContain('oops');
  });

  it('returns a non-zero exit code when the script fails', async () => {
    const out = tempDir();
    const script = makeScript('echo bye 1>&2; exit 7');
    const res = await runBashScript({
      scriptPath: script,
      args: [],
      env: {},
      stdoutPath: join(out, 'stdout.log'),
      stderrPath: join(out, 'stderr.log'),
      combinedPath: join(out, 'combined.log'),
    });
    expect(res.exitCode).toBe(7);
    expect(readFileSync(join(out, 'stderr.log'), 'utf8')).toContain('bye');
  });

  it('passes args to the script', async () => {
    const out = tempDir();
    const script = makeScript('echo "arg=$1"');
    const res = await runBashScript({
      scriptPath: script,
      args: ['42'],
      env: {},
      stdoutPath: join(out, 'stdout.log'),
      stderrPath: join(out, 'stderr.log'),
      combinedPath: join(out, 'combined.log'),
    });
    expect(res.exitCode).toBe(0);
    expect(readFileSync(join(out, 'stdout.log'), 'utf8')).toContain('arg=42');
  });

  it('passes env vars to the child process', async () => {
    const out = tempDir();
    const script = makeScript('echo "MY_VAR=$MY_VAR"');
    const res = await runBashScript({
      scriptPath: script,
      args: [],
      env: { MY_VAR: 'testval' },
      stdoutPath: join(out, 'stdout.log'),
      stderrPath: join(out, 'stderr.log'),
      combinedPath: join(out, 'combined.log'),
    });
    expect(res.exitCode).toBe(0);
    expect(readFileSync(join(out, 'stdout.log'), 'utf8')).toContain('MY_VAR=testval');
  });
});
