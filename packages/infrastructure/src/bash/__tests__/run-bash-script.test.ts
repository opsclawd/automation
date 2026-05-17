import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runBashScript } from '../run-bash-script.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-sh-'));
  tempDirs.push(dir);
  const path = join(dir, 'fake.sh');
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-out-'));
  tempDirs.push(dir);
  return dir;
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

  it('tees stdout and stderr to the parent process when tee=true', async () => {
    const out = tempDir();
    const script = makeScript('echo teed-out; echo teed-err 1>&2; exit 0');
    const parentOut: string[] = [];
    const parentErr: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      parentOut.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      parentErr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      await runBashScript({
        scriptPath: script,
        args: [],
        env: {},
        stdoutPath: join(out, 'stdout.log'),
        stderrPath: join(out, 'stderr.log'),
        combinedPath: join(out, 'combined.log'),
        tee: true,
      });
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    expect(parentOut.join('')).toContain('teed-out');
    expect(parentErr.join('')).toContain('teed-err');
    expect(readFileSync(join(out, 'stdout.log'), 'utf8')).toContain('teed-out');
    expect(readFileSync(join(out, 'stderr.log'), 'utf8')).toContain('teed-err');
  });

  it('does not tee to the parent process when tee is omitted', async () => {
    const out = tempDir();
    const script = makeScript('echo silent-out; echo silent-err 1>&2; exit 0');
    const parentOut: string[] = [];
    const parentErr: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      parentOut.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      parentErr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      await runBashScript({
        scriptPath: script,
        args: [],
        env: {},
        stdoutPath: join(out, 'stdout.log'),
        stderrPath: join(out, 'stderr.log'),
        combinedPath: join(out, 'combined.log'),
      });
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    expect(parentOut.join('')).not.toContain('silent-out');
    expect(parentErr.join('')).not.toContain('silent-err');
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

  it('interleaves stdout and stderr in combined.log in emission order', async () => {
    const out = tempDir();
    // Force ordering with sleeps so the kernel scheduler doesn't reorder
    // writes between unrelated pipes.
    const script = makeScript(
      'echo A; sleep 0.05; echo B 1>&2; sleep 0.05; echo C; sleep 0.05; echo D 1>&2',
    );
    const res = await runBashScript({
      scriptPath: script,
      args: [],
      env: {},
      stdoutPath: join(out, 'stdout.log'),
      stderrPath: join(out, 'stderr.log'),
      combinedPath: join(out, 'combined.log'),
    });
    expect(res.exitCode).toBe(0);
    const combined = readFileSync(join(out, 'combined.log'), 'utf8');
    const idxA = combined.indexOf('A');
    const idxB = combined.indexOf('B');
    const idxC = combined.indexOf('C');
    const idxD = combined.indexOf('D');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxB);
    expect(idxD).toBeGreaterThan(idxC);
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
