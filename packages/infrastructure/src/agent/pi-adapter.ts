import { execa } from 'execa';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import {
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
} from '@ai-sdlc/application';

export interface PiAdapterOptions {
  binaryPath?: string;
  artifactsDir: string;
}

export class PiAgentAdapter implements AgentPort {
  constructor(private readonly opts: PiAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    const bin = this.opts.binaryPath ?? 'pi';

    const promptChars = readFileSync(request.promptPath, 'utf-8').length;
    const approxTokens = Math.ceil(promptChars / 4);
    if (request.promptBudgetTokens !== undefined && approxTokens > request.promptBudgetTokens) {
      return {
        runtime: 'pi',
        provider: '',
        model: '',
        exitCode: 0,
        durationMs: 0,
        stdoutPath: '',
        stderrPath: '',
        contractViolations: ['prompt_budget_exceeded'],
        outcome: 'contract_violation',
      };
    }

    const invocationDir = join(
      this.opts.artifactsDir,
      `inv-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(invocationDir, { recursive: true });
    const stdoutPath = join(invocationDir, 'stdout.log');
    const stderrPath = join(invocationDir, 'stderr.log');

    const start = Date.now();
    let outcome: AgentInvocationResult['outcome'] = 'success';
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    let contractViolations: string[] = [];
    try {
      const args = ['run', '--model', request.model ?? request.profile];
      if (request.runtimeHints?.contextLimitTokens !== undefined) {
        args.push('--context-limit', String(request.runtimeHints.contextLimitTokens));
      }
      if (request.runtimeHints?.outputBudgetTokens !== undefined) {
        args.push('--max-output', String(request.runtimeHints.outputBudgetTokens));
      }
      args.push('--prompt-file', request.promptPath);

      const child = execa(bin, args, {
        cwd: request.cwd,
        reject: false,
        all: false,
        ...(request.abortSignal ? { cancelSignal: request.abortSignal } : {}),
      });
      const r = await child;
      stdout = r.stdout ?? '';
      stderr = r.stderr ?? '';
      exitCode = r.exitCode ?? 0;
      if (r.isCanceled) {
        outcome = 'failed';
        contractViolations = [...contractViolations, 'cancelled_by_orchestrator'];
      } else if (exitCode !== 0) {
        outcome = 'failed';
      }
    } catch (e) {
      outcome = 'failed';
      exitCode = 1;
      stderr = String((e as Error).message);
    }
    writeFileSync(stdoutPath, stdout);
    writeFileSync(stderrPath, stderr);

    const durationMs = Date.now() - start;
    let endCommitSha: string | undefined;
    try {
      endCommitSha = execSync('git rev-parse HEAD', { cwd: request.cwd }).toString().trim();
    } catch {
      contractViolations = [...contractViolations, 'missing_commit'];
    }

    const ret: AgentInvocationResult = {
      runtime: 'pi',
      provider: '',
      model: '',
      exitCode,
      durationMs,
      stdoutPath,
      stderrPath,
      contractViolations,
      outcome,
    };
    if (endCommitSha) ret.endCommitSha = endCommitSha;
    return ret;
  }
}
