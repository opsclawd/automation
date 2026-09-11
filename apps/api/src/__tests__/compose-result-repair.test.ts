import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { AgentInvocationId } from '@ai-sdlc/domain';
import { extractResult } from '@ai-sdlc/application';
import { GitWorktreeAdapter, StructuredResultRepair } from '@ai-sdlc/infrastructure';
import { FakeArtifactStore } from '@ai-sdlc/application/test-doubles';
import type { AgentPort, AgentInvocationRequest, GitPort } from '@ai-sdlc/application/ports';
import type { RunId, PhaseName } from '@ai-sdlc/domain';
import { buildReviewFixFixPrompt } from '../review-fix-prompts.js';

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

  it('redirects candidate result.json to fix-review-result.json when fallback agent writes to result.json (#1162)', async () => {
    const cwd = path.join(os.tmpdir(), 'repair-candidate-test-' + Date.now());
    mkdirSync(cwd, { recursive: true });

    execSync('git init', { cwd, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd, stdio: 'ignore' });
    execSync('git config user.name "test"', { cwd, stdio: 'ignore' });
    writeFileSync(path.join(cwd, '.gitignore'), '*.json\n');
    writeFileSync(path.join(cwd, 'README.md'), '# Test\n');
    execSync('git add .gitignore README.md', { cwd, stdio: 'ignore' });
    execSync('git commit -m "init"', { cwd, stdio: 'ignore' });
    const head = execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8' }).trim();

    const git = new GitWorktreeAdapter();
    const fakeAgent = {
      calls: [] as AgentInvocationRequest[],
      invoke: async (req: AgentInvocationRequest) => {
        fakeAgent.calls.push(req);
        // Fallback agent mistakenly writes to result.json instead of fix-review-result.json
        writeFileSync(
          path.join(req.cwd, 'result.json'),
          JSON.stringify({ result: 'done_with_fixes' }),
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
      git,
      agent: fakeAgent as unknown as AgentPort,
      repairProfile: 'task-reviewer',
    });

    const artifacts = new FakeArtifactStore();
    const runId = 'test-run-1162';
    const stdoutPath = path.join(cwd, 'stdout.log');
    writeFileSync(stdoutPath, 'Primary fix attempt evidence\n');

    const invocation = {
      id: AgentInvocationId('inv-1162'),
      runId: runId as unknown as RunId,
      phaseId: 'fix-review' as unknown as PhaseName,
      resultJsonPath: 'fix-review-result.json',
      startCommitSha: head,
      stdoutPath,
      stderrPath: path.join(cwd, 'stderr.log'),
    };
    writeFileSync(invocation.stderrPath, '');

    artifacts.read = async (_rId: string, relPath: string) => {
      const p = path.join(cwd, relPath);
      if (!existsSync(p)) {
        throw new Error(`artifact not found: ${relPath}`);
      }
      return readFileSync(p, 'utf-8');
    };

    const verdict = await extractResult({
      invocation,
      ports: {
        artifacts,
        agent: fakeAgent,
        repair,
      },
      cwd,
    });

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.result).toMatchObject({ result: 'done_with_fixes' });
    }
    expect(fakeAgent.calls.length).toBe(1);
    expect(fakeAgent.calls[0]!.fallbackReason).toBe('serialization_repair');
    expect(existsSync(path.join(cwd, 'result.json'))).toBe(false);
    expect(existsSync(path.join(cwd, 'fix-review-result.json'))).toBe(true);
  });

  it('rolls back stray wrong-result.json and fails repair when fallback agent writes to unexpected file (#1162)', async () => {
    const cwd = path.join(os.tmpdir(), 'repair-wrong-path-test-' + Date.now());
    mkdirSync(cwd, { recursive: true });

    execSync('git init', { cwd, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd, stdio: 'ignore' });
    execSync('git config user.name "test"', { cwd, stdio: 'ignore' });
    writeFileSync(path.join(cwd, '.gitignore'), '*.json\n');
    writeFileSync(path.join(cwd, 'README.md'), '# Test\n');
    execSync('git add .gitignore README.md', { cwd, stdio: 'ignore' });
    execSync('git commit -m "init"', { cwd, stdio: 'ignore' });
    const head = execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8' }).trim();

    const git = new GitWorktreeAdapter();
    const fakeAgent = {
      calls: [] as AgentInvocationRequest[],
      invoke: async (req: AgentInvocationRequest) => {
        fakeAgent.calls.push(req);
        // Fallback agent writes to unexpected path 'wrong-result.json'
        writeFileSync(
          path.join(req.cwd, 'wrong-result.json'),
          JSON.stringify({ result: 'done_with_fixes' }),
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
          resultJsonPath: 'wrong-result.json',
        };
      },
    };

    const repair = new StructuredResultRepair({
      git,
      agent: fakeAgent as unknown as AgentPort,
      repairProfile: 'task-reviewer',
    });

    const artifacts = new FakeArtifactStore();
    const runId = 'test-run-1162-fail';
    const stdoutPath = path.join(cwd, 'stdout.log');
    writeFileSync(stdoutPath, 'Primary fix attempt evidence\n');

    const invocation = {
      id: AgentInvocationId('inv-1162-fail'),
      runId: runId as unknown as RunId,
      phaseId: 'fix-review' as unknown as PhaseName,
      resultJsonPath: 'fix-review-result.json',
      startCommitSha: head,
      stdoutPath,
      stderrPath: path.join(cwd, 'stderr.log'),
    };
    writeFileSync(invocation.stderrPath, '');

    artifacts.read = async (_rId: string, relPath: string) => {
      const p = path.join(cwd, relPath);
      if (!existsSync(p)) {
        throw new Error(`artifact not found: ${relPath}`);
      }
      return readFileSync(p, 'utf-8');
    };

    const verdict = await extractResult({
      invocation,
      ports: {
        artifacts,
        agent: fakeAgent,
        repair,
      },
      cwd,
    });

    expect(verdict.ok).toBe(false);
    expect(fakeAgent.calls.length).toBe(1);
    expect(existsSync(path.join(cwd, 'wrong-result.json'))).toBe(false);
    expect(existsSync(path.join(cwd, 'fix-review-result.json'))).toBe(false);
  });

  it('ensures deterministic gate output appears in fixer prompt', () => {
    const diagnostic = 'deterministic build failure output details';

    const fixerPrompt = buildReviewFixFixPrompt({
      cwd: '/dummy/cwd',
      repoId: 'dummy-repo',
      useFallback: false,
      deterministicDiagnostic: diagnostic,
    });

    const standardPrompt = buildReviewFixFixPrompt({
      cwd: '/dummy/cwd',
      repoId: 'dummy-repo',
      useFallback: false,
    });

    expect(fixerPrompt).toContain(diagnostic);
    expect(fixerPrompt).toContain('DETERMINISTIC DIAGNOSTIC');
    expect(standardPrompt).not.toContain(diagnostic);
    expect(standardPrompt).not.toContain('DETERMINISTIC DIAGNOSTIC');
  });
});
