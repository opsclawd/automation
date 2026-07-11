import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentInvocationId, AgentProfileName } from '@ai-sdlc/domain';
import { FakeAgentPort, FakeGitPort } from '@ai-sdlc/application/test-doubles';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';
import {
  StructuredResultRepair,
  buildStructuredResultRepairPrompt,
} from '../structured-result-repair.js';

const RUN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PRIMARY_ID = AgentInvocationId('00000000-0000-0000-0000-000000000001');
const DEFAULT_PROFILE = 'task-reviewer';
const CUSTOM_PROFILE = 'codex-writer';

const SUCCESS_RESULT: AgentInvocationResult = {
  runtime: 'opencode',
  provider: 'p',
  model: 'm',
  exitCode: 0,
  durationMs: 1,
  stdoutPath: '/tmp/repair.stdout',
  stderrPath: '/tmp/repair.stderr',
  contractViolations: [],
  outcome: 'success',
};

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'structured-repair-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = 1;\n');
  writeFileSync(join(dir, 'result.json'), '{\n  "status": "seed"\n}\n');
  return dir;
}

function makeInput(
  overrides: Partial<Parameters<StructuredResultRepair['repairStructuredResult']>[0]> = {},
) {
  return {
    runId: RUN_ID,
    cwd: '/tmp/worktree',
    normalizedPhase: 'quality-review',
    destination: 'result.json',
    schemaContractText: '{"type":"object"}',
    cappedRawArtifact: '{\n  "status": "broken-primary"\n}\n',
    transcriptEvidence: 'primary transcript evidence',
    expectedHead: 'abc123',
    classification: 'invalid_result_json',
    primaryInvocation: {
      id: PRIMARY_ID,
      stdoutPath: '/tmp/primary.stdout',
      stderrPath: '/tmp/primary.stderr',
    },
    ...overrides,
  };
}

function primaryChanges(cwd: string): { sourceBefore: string; destBefore: string } {
  const sourcePath = join(cwd, 'src', 'app.ts');
  const destPath = join(cwd, 'result.json');
  writeFileSync(sourcePath, 'export const app = 2;\n');
  writeFileSync(destPath, '{\n  "status": "broken-primary"\n}\n');
  const sourceBefore = readFileSync(sourcePath, 'utf-8');
  const destBefore = readFileSync(destPath, 'utf-8');
  return { sourceBefore, destBefore };
}

function setup(
  overrides: {
    repairProfile?: string;
    writer?: (cwd: string) => (req: AgentInvocationRequest) => Promise<AgentInvocationResult>;
    stdoutText?: string;
    promptBuilder?: typeof buildStructuredResultRepairPrompt;
    input?: Partial<Parameters<StructuredResultRepair['repairStructuredResult']>[0]>;
  } = {},
) {
  const cwd = makeWorkspace();
  const { sourceBefore, destBefore } = primaryChanges(cwd);
  const git = new FakeGitPort();
  git.headByCwd.set(cwd, 'abc123');
  git.statusByCwd.set(cwd, ' M src/app.ts\n M result.json\n');
  const stdoutPath = join(cwd, 'primary.stdout');
  writeFileSync(
    stdoutPath,
    overrides.stdoutText ??
      'primary summary start\n' +
        'PRIMARY_BOUNDED_MARKER\n' +
        'x'.repeat(9000) +
        '\nprimary summary end\n',
  );
  const agent = new FakeAgentPort({
    [overrides.repairProfile ?? DEFAULT_PROFILE]: [
      overrides.writer?.(cwd) ??
        (async (req) => {
          writeFileSync(join(cwd, req.expectedArtifacts[0]!), '{"status":"repaired"}\n');
          return SUCCESS_RESULT;
        }),
    ],
  });
  const repair = new StructuredResultRepair({
    git,
    agent,
    repairProfile: overrides.repairProfile ?? DEFAULT_PROFILE,
    ...(overrides.promptBuilder ? { promptBuilder: overrides.promptBuilder } : {}),
  });
  const input = makeInput({
    cwd,
    primaryInvocation: {
      id: PRIMARY_ID,
      stdoutPath,
      stderrPath: join(cwd, 'primary.stderr'),
    },
    ...overrides.input,
  });
  return { cwd, git, agent, repair, input, sourceBefore, destBefore };
}

describe('StructuredResultRepair', () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs = [];
  });

  it('uses the configured profile, links the repair invocation, and tags serialization_repair metadata', async () => {
    const env = setup({ repairProfile: CUSTOM_PROFILE });
    dirs.push(env.cwd);
    const result = await env.repair.repairStructuredResult(env.input);

    expect(result.outcome).toBe('repaired');
    expect(result.repairInvocationId).toBeDefined();
    expect(env.agent.invocations).toHaveLength(1);

    const req = env.agent.invocations[0]!;
    expect(req.profile).toBe(AgentProfileName(CUSTOM_PROFILE));
    expect(req.fallbackOfInvocationId).toBe(PRIMARY_ID);
    expect(req.fallbackReason).toBe('serialization_repair');
    expect(req.metadata).toMatchObject({
      invocation_type: 'serialization_repair',
      classification: 'invalid_result_json',
      normalized_phase: 'quality-review',
      transcript_evidence: 'primary transcript evidence',
    });
  });

  it('keeps the prompt bounded and omits git-diff/repository context', async () => {
    let capturedPrompt = '';
    const env = setup({
      input: {
        cappedRawArtifact: 'RAW_MARKER\n' + 'x'.repeat(9000),
      },
      stdoutText: 'STDOUT_MARKER\n' + 'x'.repeat(9000) + '\nprimary summary end\n',
      promptBuilder: (input) => {
        capturedPrompt = buildStructuredResultRepairPrompt(input);
        return capturedPrompt;
      },
    });
    dirs.push(env.cwd);
    writeFileSync(join(env.cwd, 'result.json'), env.input.cappedRawArtifact);
    env.git.statusByCwd.set(env.cwd, ' M src/app.ts\n M result.json\n');
    await env.repair.repairStructuredResult(env.input);

    expect(capturedPrompt).toContain('result.json');
    expect(capturedPrompt).toContain('{"type":"object"}');
    expect(capturedPrompt).not.toContain('RAW_MARKER');
    expect(capturedPrompt).not.toContain('STDOUT_MARKER');
    expect(capturedPrompt).not.toContain('git log');
    expect(capturedPrompt).not.toContain('diff --git');
    expect(capturedPrompt).not.toContain('repoId');
    expect(capturedPrompt).not.toContain('HEAD SHA');
  });

  it('returns not_attempted when the destination is missing', async () => {
    const env = setup({ input: { destination: 'missing-result.json' } });
    dirs.push(env.cwd);
    const result = await env.repair.repairStructuredResult(env.input);
    expect(result.outcome).toBe('not_attempted');
    expect(env.agent.invocations).toHaveLength(0);
  });

  it('returns not_attempted when the destination path escapes the worktree', async () => {
    const env = setup({ input: { destination: '../escape/result.json' } });
    dirs.push(env.cwd);
    const result = await env.repair.repairStructuredResult(env.input);
    expect(result.outcome).toBe('not_attempted');
    expect(env.agent.invocations).toHaveLength(0);
  });

  it('returns not_attempted when no primary invocation exists', async () => {
    const env = setup({ input: { primaryInvocation: undefined as never } });
    dirs.push(env.cwd);
    const result = await env.repair.repairStructuredResult(env.input);
    expect(result.outcome).toBe('not_attempted');
    expect(env.agent.invocations).toHaveLength(0);
  });

  it('returns repaired without touching primary source edits when the writer only changes the destination', async () => {
    const env = setup();
    dirs.push(env.cwd);
    const result = await env.repair.repairStructuredResult(env.input);
    expect(result.outcome).toBe('repaired');
    expect(readFileSync(join(env.cwd, 'src', 'app.ts'), 'utf-8')).toBe(env.sourceBefore);
    expect(readFileSync(join(env.cwd, 'result.json'), 'utf-8')).toBe('{"status":"repaired"}\n');
  });

  it('returns failed and restores source-file mutations when the writer changes another file', async () => {
    const env = setup({
      writer: (cwd) => async () => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 3;\n');
        writeFileSync(join(cwd, 'result.json'), '{"status":"repaired"}\n');
        return SUCCESS_RESULT;
      },
    });
    dirs.push(env.cwd);
    const result = await env.repair.repairStructuredResult(env.input);
    expect(result.outcome).toBe('failed');
    expect(readFileSync(join(env.cwd, 'src', 'app.ts'), 'utf-8')).toBe(env.sourceBefore);
    expect(readFileSync(join(env.cwd, 'result.json'), 'utf-8')).toBe(env.destBefore);
  });

  it('returns failed and cleans up when the writer throws', async () => {
    const env = setup({
      writer: async () => {
        throw new Error('boom');
      },
    });
    dirs.push(env.cwd);
    const result = await env.repair.repairStructuredResult(env.input);
    expect(result.outcome).toBe('failed');
    expect(readFileSync(join(env.cwd, 'src', 'app.ts'), 'utf-8')).toBe(env.sourceBefore);
    expect(readFileSync(join(env.cwd, 'result.json'), 'utf-8')).toBe(env.destBefore);
  });

  it('is idempotent after a repaired destination no longer matches the raw artifact', async () => {
    const env = setup();
    dirs.push(env.cwd);
    const first = await env.repair.repairStructuredResult(env.input);
    expect(first.outcome).toBe('repaired');
    const second = await env.repair.repairStructuredResult(env.input);
    expect(second.outcome).toBe('not_attempted');
    expect(env.agent.invocations).toHaveLength(1);
  });
});
