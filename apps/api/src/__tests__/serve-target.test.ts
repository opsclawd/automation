import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { composeRoot } from '../compose.js';
import { startServer } from '../server.js';
import { buildProgram } from '../cli.js';

describe('orchestrator serve --target-repo-root', () => {
  let tmpDir: string;
  let targetRepo: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'test-serve-target-'));
    targetRepo = join(tmpDir, 'target-repo');
    mkdirSync(targetRepo, { recursive: true });
    execFileSync('git', ['init'], { cwd: targetRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: targetRepo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: targetRepo });
    writeFileSync(join(targetRepo, 'README.md'), '# Target Repo');
    execFileSync('git', ['add', '.'], { cwd: targetRepo });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: targetRepo });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves metadata and runs for the target repository', async () => {
    const repoRoot = resolve(process.cwd());
    const container = composeRoot({
      repoRoot,
      targetRepoRoot: targetRepo,
      scriptPath: join(repoRoot, 'scripts/legacy/ai-run-issue-v2'),
      runStartupSweeps: false,
      repoFullName: 'test-owner/target-repo',
    });

    const server = await startServer({ container, port: 0, forceCloseAllOnStop: true });
    const addr = server.address as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const metaRes = await fetch(`${baseUrl}/api/meta`);
      expect(metaRes.status).toBe(200);
      const meta = await metaRes.json() as any;
      expect(meta.repoFullName).toBe('test-owner/target-repo');
      expect(resolve(meta.targetRepoRoot)).toBe(resolve(targetRepo));

      const runsRes = await fetch(`${baseUrl}/api/runs`);
      expect(runsRes.status).toBe(200);
      const runs = await runsRes.json() as any;
      expect(runs.runs).toEqual([]);
      expect(runs.total).toBe(0);
    } finally {
      await server.stop();
    }
  });
});

describe('CLI serve command --target-repo-root', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'test-cli-serve-target-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('fails when target repo root is not a git repo', async () => {
    const notARepo = join(tmpDir, 'not-a-repo');
    mkdirSync(notARepo);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit');
    }) as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const program = buildProgram({
      isCliTestSuite: true,
      bypassPlanValidation: true,
    });

    // commander will throw if exitOverride is used and process.exit is called
    await expect(program.parseAsync([
      'node', 'orchestrator', 'serve', '--port', '0', '--target-repo-root', notARepo
    ])).rejects.toThrow();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not inside a git working tree'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
