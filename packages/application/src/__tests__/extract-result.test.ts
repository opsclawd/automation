import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentInvocationId, AgentProfileName, PhaseName, RunId } from '@ai-sdlc/domain';
import type { AgentInvocation } from '@ai-sdlc/domain';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { FakeArtifactStore, FakeStructuredResultRepair } from '../test-doubles/index.js';
import { extractResult } from '../results/extract-result.js';
import { PHASE_RESULT_REGISTRY } from '../results/phase-registry.js';

function makeInvocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    id: AgentInvocationId('inv-1'),
    runId: RunId('r1'),
    phaseId: PhaseName('implement'),
    profile: AgentProfileName('p'),
    runtime: 'opencode',
    provider: 'a',
    model: 'm',
    promptPath: '/p',
    promptChars: 1,
    stdoutPath: '/s',
    stderrPath: '/e',
    startedAt: new Date(),
    startCommitSha: 'a'.repeat(40),
    timeoutMs: 1000,
    resultJsonPath: 'result.json',
    ...overrides,
  };
}

const PHASE_TESTS = [
  {
    phase: 'implement',
    validJson: { result: 'success', changedFiles: ['src/foo.ts'] },
    invalidJson: { bad: 'shape' },
  },
  {
    phase: 'quality-review',
    validJson: { result: 'pass', findings: [] },
    invalidJson: { bad: 'shape' },
  },
];

describe('extractResult coordinator', () => {
  let tempDir: string;
  let stdoutPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'extract-result-test-'));
    stdoutPath = join(tempDir, 'stdout.log');
    writeFileSync(stdoutPath, 'some logs representing evidence\n');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws on unknown phase', async () => {
    const artifacts = new FakeArtifactStore();
    const repair = new FakeStructuredResultRepair();
    await expect(
      extractResult({
        invocation: makeInvocation({ phaseId: PhaseName('nonexistent') }),
        ports: { artifacts, repair },
      }),
    ).rejects.toThrow("no result schema registered for phase 'nonexistent'");
  });

  it('resolves dynamic phase IDs like fix-validate-1 against the registry', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'r1',
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'fixed' }),
    });
    const repair = new FakeStructuredResultRepair();
    const outcome = await extractResult({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invocation: makeInvocation({ phaseId: PhaseName('fix-validate-1' as any) }),
      ports: { artifacts, repair },
    });
    expect(outcome.ok).toBe(true);
  });

  describe.each(PHASE_TESTS)('phase=$phase', ({ phase, validJson, invalidJson }) => {
    it('valid data has no repair', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: JSON.stringify(validJson),
      });
      const repair = new FakeStructuredResultRepair();
      const outcome = await extractResult({
        invocation: makeInvocation({ phaseId: PhaseName(phase), stdoutPath }),
        ports: { artifacts, repair },
      });
      expect(outcome).toEqual({ ok: true, result: validJson });
      expect(repair.calls).toHaveLength(0);
    });

    it('malformed/missing data repairs once with evidence', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: JSON.stringify(invalidJson),
      });
      const repair = new FakeStructuredResultRepair();
      repair.response = async () => {
        await artifacts.write({
          runId: 'r1',
          relativePath: 'result.json',
          contents: JSON.stringify(validJson),
        });
        return { outcome: 'repaired', repairInvocationId: AgentInvocationId('rep-123') };
      };

      const outcome = await extractResult({
        invocation: makeInvocation({ phaseId: PhaseName(phase), stdoutPath }),
        ports: { artifacts, repair },
        cwd: '/cwd',
      });

      expect(outcome).toEqual({
        ok: true,
        result: validJson,
        repairInvocationId: AgentInvocationId('rep-123'),
      });
      expect(repair.calls).toHaveLength(1);
    });

    it('repaired data is Zod-validated (invalid repaired JSON fails)', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: JSON.stringify(invalidJson),
      });
      const repair = new FakeStructuredResultRepair();
      repair.response = async () => {
        // repair returns invalid json again
        await artifacts.write({
          runId: 'r1',
          relativePath: 'result.json',
          contents: JSON.stringify(invalidJson),
        });
        return { outcome: 'repaired', repairInvocationId: AgentInvocationId('rep-123') };
      };

      const outcome = await extractResult({
        invocation: makeInvocation({ phaseId: PhaseName(phase), stdoutPath }),
        ports: { artifacts, repair },
        cwd: '/cwd',
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.classification).toBe('unrecoverable_artifact');
      }
      expect(repair.calls).toHaveLength(1);
    });

    it('invalid/thrown repair does not recurse', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: JSON.stringify(invalidJson),
      });
      const repair = new FakeStructuredResultRepair();
      repair.response = { outcome: 'failed' };

      const outcome = await extractResult({
        invocation: makeInvocation({ phaseId: PhaseName(phase), stdoutPath }),
        ports: { artifacts, repair },
        cwd: '/cwd',
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.classification).toBe('unrecoverable_artifact');
      }
      expect(repair.calls).toHaveLength(1);
    });

    it('no evidence is terminal (unrecoverable_artifact, no repair call)', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: JSON.stringify(invalidJson),
      });
      const repair = new FakeStructuredResultRepair();

      const outcome = await extractResult({
        // Point stdoutPath to a non-existent file
        invocation: makeInvocation({
          phaseId: PhaseName(phase),
          stdoutPath: '/nonexistent-stdout',
        }),
        ports: { artifacts, repair },
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.classification).toBe('unrecoverable_artifact');
      }
      expect(repair.calls).toHaveLength(0);
    });
  });

  it('returns missing when resultJsonPath is not set', async () => {
    const artifacts = new FakeArtifactStore();
    const outcome = await extractResult({
      invocation: makeInvocation({ resultJsonPath: undefined }),
      ports: { artifacts },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.classification).toBe('unrecoverable_artifact');
      expect(outcome.reason).toBe('missing');
    }
  });

  it('returns missing with detail when artifact not found in store', async () => {
    const artifacts = new FakeArtifactStore();
    const outcome = await extractResult({
      invocation: makeInvocation({ phaseId: PhaseName('implement') }),
      ports: { artifacts },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.classification).toBe('unrecoverable_artifact');
      expect(outcome.reason).toBe('missing');
      expect(outcome.detail).toBe('artifact not found: result.json in run r1');
    }
  });

  it('uses an explicit repairExpectedHead before the invocation start SHA', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'r1',
      relativePath: 'result.json',
      contents: JSON.stringify({ bad: 'shape' }),
    });
    const repair = new FakeStructuredResultRepair();
    repair.response = { outcome: 'failed' };

    await extractResult({
      invocation: makeInvocation({
        phaseId: PhaseName('implement'),
        startCommitSha: 'start-sha',
        endCommitSha: 'end-sha',
        stdoutPath,
      }),
      ports: { artifacts, repair },
      repairExpectedHead: 'explicit-sha',
    });

    expect(repair.calls[0]?.expectedHead).toBe('explicit-sha');
  });

  it('uses endCommitSha as the repair baseline when no explicit baseline is supplied', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'r1',
      relativePath: 'result.json',
      contents: JSON.stringify({ bad: 'shape' }),
    });
    const repair = new FakeStructuredResultRepair();
    repair.response = { outcome: 'failed' };

    await extractResult({
      invocation: makeInvocation({
        phaseId: PhaseName('implement'),
        startCommitSha: 'start-sha',
        endCommitSha: 'end-sha',
        stdoutPath,
      }),
      ports: { artifacts, repair },
    });

    expect(repair.calls[0]?.expectedHead).toBe('end-sha');
  });

  it('re-validates a repaired fix-review artifact exactly once and rejects invalid repaired JSON', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'r1',
      relativePath: 'result.json',
      contents: JSON.stringify({ bad: 'shape' }),
    });
    const repair = new FakeStructuredResultRepair();
    let revalidateCalls = 0;
    repair.response = async () => {
      revalidateCalls++;
      await artifacts.write({
        runId: 'r1',
        relativePath: 'result.json',
        contents: JSON.stringify({ bad: 'shape' }),
      });
      return { outcome: 'repaired', repairInvocationId: AgentInvocationId('rep-123') };
    };

    const outcome = await extractResult({
      invocation: makeInvocation({
        phaseId: PhaseName('fix-review'),
        stdoutPath,
      }),
      ports: { artifacts, repair },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.classification).toBe('unrecoverable_artifact');
    expect(repair.calls).toHaveLength(1);
    expect(revalidateCalls).toBe(1);
  });
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '__fixtures__', 'result-json');

describe('fixture files validate against their phase schemas', () => {
  const phases = readdirSync(FIXTURE_DIR);
  for (const phase of phases) {
    it(`${phase}/valid.json passes its schema`, () => {
      const raw = readFileSync(join(FIXTURE_DIR, phase, 'valid.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      const meta = PHASE_RESULT_REGISTRY[phase];
      expect(meta, `phase '${phase}' must exist in PHASE_RESULT_REGISTRY`).toBeDefined();
      const result = meta.schema.safeParse(parsed);
      expect(
        result.success,
        `fixture for '${phase}' must validate: ${result.success ? '' : (result as { error: { message: string } }).error.message}`,
      ).toBe(true);
    });
  }
});
