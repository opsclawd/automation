import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRoot } from '../compose.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function trackDir<T>(fn: () => T): T {
  const result = fn();
  tempDirs.push(result);
  return result;
}

function fakeScript(exitCode: number): string {
  const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
  const path = join(dir, 'run.sh');
  writeFileSync(path, `#!/usr/bin/env bash\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('composeRoot', () => {
  it('wires dependencies correctly and can execute a run against a fake script', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const container = composeRoot({
      repoRoot: root,
      scriptPath,
    });

    expect(container.runRepository).toBeDefined();
    expect(container.phaseRepository).toBeDefined();
    expect(container.eventRepository).toBeDefined();
    expect(container.artifactRepository).toBeDefined();
    expect(container.failureRepository).toBeDefined();
    expect(container.startIssueRun).toBeDefined();
    expect(container.runsDir).toBe(join(root, '.ai-runs'));

    const out = await container.startIssueRun.execute({ issueNumber: 1 });
    expect(out.status).toBe('passed');
    expect(out.exitCode).toBe(0);
    expect(out.uuid).toBeTruthy();

    const row = container.runRepository.findByUuid(out.uuid);
    expect(row?.status).toBe('passed');
  });

  it('passes optional deps through to StartIssueRun', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const scriptPath = join(dir, 'env.sh');
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash\necho "BRANCH=$AI_BASE_BRANCH MODEL=$AI_MODEL RUNTIME=$AI_RUNTIME"\nexit 0\n`,
    );
    chmodSync(scriptPath, 0o755);

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      baseBranch: 'develop',
      model: 'gpt-4',
      agentCli: 'codex',
    });

    const out = await container.startIssueRun.execute({ issueNumber: 2 });
    expect(out.status).toBe('passed');
  });

  it('classifies failure from phase.failed event end-to-end', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const scriptPath = join(dir, 'fail-with-event.sh');
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash
mkdir -p "$(dirname "$AI_RUN_EVENTS_FILE")"
echo '{"runId":"'"$AI_RUN_DISPLAY_ID"'","phase":"validate","level":"error","type":"phase.failed","message":"pnpm build failed","timestamp":"2026-05-18T10:00:00.000Z","metadata":{"command":"pnpm build","exitCode":2}}' >> "$AI_RUN_EVENTS_FILE"
sleep 0.3
exit 1
`,
    );
    chmodSync(scriptPath, 0o755);

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
    });

    const out = await container.startIssueRun.execute({ issueNumber: 42 });
    expect(out.status).toBe('failed');
    expect(out.exitCode).toBe(1);

    const failure = container.failureRepository.findLatestByRun(out.uuid);
    expect(failure).toBeDefined();
    expect(failure!.kind).toBe('validation_failed');
    expect(failure!.phase).toBe('validate');
    expect(failure!.exitCode).toBe(2);
    expect(failure!.message).toMatch(/pnpm build/);

    const runDir = join(container.runsDir, out.displayId);
    if (existsSync(join(runDir, 'failure.json'))) {
      const failureJson = JSON.parse(readFileSync(join(runDir, 'failure.json'), 'utf-8'));
      expect(failureJson.kind).toBe('validation_failed');
      expect(failureJson.phase).toBe('validate');
    }
  });
});
