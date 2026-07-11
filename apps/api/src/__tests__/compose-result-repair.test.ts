import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { AgentInvocationId } from '@ai-sdlc/domain';
import { extractResult } from '@ai-sdlc/application';
import { StructuredResultRepair } from '@ai-sdlc/infrastructure';
import { FakeArtifactStore } from '@ai-sdlc/application/test-doubles';
import type { AgentPort, AgentInvocationRequest, GitPort } from '@ai-sdlc/application/ports';
import type { RunId, PhaseName } from '@ai-sdlc/domain';

describe('compose-result-repair', () => {
  it('wires StructuredResultRepair correctly using the result-writer profile name and invokes it for malformed JSON with evidence', async () => {
    const cwd = path.join(os.tmpdir(), 'repair-test-' + Date.now());
    mkdirSync(cwd, { recursive: true });

    // Initialize actual git repository in temp directory to support git commands
    execSync('git init', { cwd, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd, stdio: 'ignore' });
    execSync('git config user.name "test"', { cwd, stdio: 'ignore' });

    const destPath = path.join(cwd, 'result.json');
    writeFileSync(destPath, 'original result content');
    execSync('git add result.json', { cwd, stdio: 'ignore' });
    execSync('git commit -m "add result.json"', { cwd, stdio: 'ignore' });
    const head = execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8' }).trim();

    // Modify result.json to be malformed after commit
    writeFileSync(destPath, 'malformed JSON {');

    const gitAdapter: Partial<GitPort> = {
      status: async () => ' M result.json',
      headCommitSha: async () => head,
    };

    const fakeAgent = {
      calls: [] as AgentInvocationRequest[],
      invoke: async (req: AgentInvocationRequest) => {
        fakeAgent.calls.push(req);
        // Write the repaired JSON to the actual workspace file in temp cwd
        writeFileSync(
          path.join(req.cwd, req.expectedArtifacts[0]!),
          JSON.stringify({ result: 'pass', findings: [] }),
        );
        return {
          runtime: 'opencode' as const,
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          exitCode: 0,
          durationMs: 1,
          stdoutPath: '/tmp/stdout',
          stderrPath: '/tmp/stderr',
          contractViolations: [],
          outcome: 'success' as const,
          resultJsonPath: 'result.json',
        };
      },
    };

    const repair = new StructuredResultRepair({
      git: gitAdapter as GitPort,
      agent: fakeAgent as unknown as AgentPort,
      repairProfile: 'task-reviewer',
    });

    const artifacts = new FakeArtifactStore();
    const runId = 'test-run-123';

    const invocation = {
      id: AgentInvocationId('inv-123'),
      runId: runId as unknown as RunId,
      phaseId: 'whole-pr-review' as unknown as PhaseName,
      resultJsonPath: 'result.json',
      startCommitSha: head,
      stdoutPath: path.join(cwd, 'stdout.log'),
      stderrPath: path.join(cwd, 'stderr.log'),
    };

    writeFileSync(invocation.stdoutPath, 'Some output from agent stdout.');
    writeFileSync(invocation.stderrPath, '');

    // Write to artifact store
    await artifacts.write({
      runId,
      phaseId: 'whole-pr-review',
      relativePath: 'result.json',
      contents: 'malformed JSON {',
    });

    // Mock read on artifacts to fetch current file state from workspace path so the validation step finds the repaired content written by the agent
    artifacts.read = async (_rId: string, relPath: string) => {
      return readFileSync(path.join(cwd, relPath), 'utf-8');
    };

    const ports = {
      artifacts,
      agent: fakeAgent,
      repair,
    };

    const verdict = await extractResult({
      invocation,
      ports,
      cwd,
    });

    expect(verdict.ok).toBe(true);
    expect(fakeAgent.calls.length).toBe(1);
    expect(fakeAgent.calls[0]!.profile).toBe('task-reviewer');
    expect(fakeAgent.calls[0]!.fallbackReason).toBe('serialization_repair');
  });
});
