import { execa } from 'execa';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { testQuotaPatterns, testProviderErrorPatterns } from './error-patterns.js';
import { remediateMissingArtifacts } from './artifact-remediation.js';
import { CONTRACT_VIOLATION_CODES } from '@ai-sdlc/application/ports';
import type { AgentPort } from '@ai-sdlc/application/ports';
import type { AgentInvocationRequest, AgentInvocationResult } from '@ai-sdlc/application/ports';

// opencode emits provider/LLM diagnostics on these service channels. Quota /
// provider-error detection is scoped to these lines so it keys on opencode's OWN
// runtime responses (real 429s, auth failures) and never on agent transcript
// content (e.g. a file the agent read, or a `git log` line containing "429").
const PROVIDER_LOG_SERVICES = /service=(?:llm|provider)\b/;

// Match `tokens=` prefix and extract the JSON payload
const TOKENS_PREFIX_RE = /tokens=(\{.*\})/;

export interface SessionLogUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}

export function parseSessionLogUsage(content: string): SessionLogUsage | undefined {
  const lines = content.split('\n');
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cachedTokens = 0;
  let hasAny = false;
  for (const line of lines) {
    if (!PROVIDER_LOG_SERVICES.test(line)) continue;
    const match = TOKENS_PREFIX_RE.exec(line);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]!);
      inputTokens += parsed.input ?? 0;
      outputTokens += parsed.output ?? 0;
      if (parsed.cacheRead) cachedTokens += parsed.cacheRead;
      if (parsed.cache?.read) cachedTokens += parsed.cache.read;
      if (parsed.reasoningTokens) reasoningTokens += parsed.reasoningTokens;
      if (parsed.reasoning) reasoningTokens += parsed.reasoning;
      hasAny = true;
    } catch {
      // Malformed tokens JSON — skip silently
    }
  }
  return hasAny
    ? {
        inputTokens,
        outputTokens,
        ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
        ...(cachedTokens > 0 ? { cachedTokens } : {}),
      }
    : undefined;
}

export interface OpenCodeAdapterOptions {
  binaryPath?: string;
  artifactsDir: string;
  timeoutMsDefault?: number;
  quotaPollMs?: number;
  // Override the directory scanned for opencode's session log. Defaults to
  // opencode's real location, ${XDG_DATA_HOME:-~/.local/share}/opencode/log —
  // the dir opencode actually writes to (it does NOT honor OPENCODE_SESSION_LOG_DIR).
  // Tests inject a temp dir here.
  logDir?: string;
  // Root of the git repository. When set, stray-recovery also scans
  // <repoRoot>/apps/cli/ for artifacts that drifted to the main checkout
  // outside the worktree (cwd). The worktree path is always checked first.
  repoRoot?: string;
}

export class OpenCodeAgentAdapter implements AgentPort {
  constructor(private readonly opts: OpenCodeAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    let watchdogKilled = false;
    let watchdogKilledType: 'quota' | 'provider' | null = null;
    let watchdogMatch = '';

    const bin = this.opts.binaryPath ?? 'opencode';
    const invocationDir = join(
      this.opts.artifactsDir,
      `inv-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(invocationDir, { recursive: true });
    const stdoutPath = join(invocationDir, 'stdout.log');
    const stderrPath = join(invocationDir, 'stderr.log');
    // opencode writes its session log to ${XDG_DATA_HOME:-~/.local/share}/opencode/log
    // and ignores OPENCODE_SESSION_LOG_DIR (verified: 0 refs in the binary). Scan the
    // real location. Redirecting XDG_DATA_HOME is NOT an option — it would orphan
    // opencode's auth.json / opencode.db (both live under the data home). See #255.
    const xdgDataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
    const sessionLogDir = this.opts.logDir ?? join(xdgDataHome, 'opencode', 'log');
    mkdirSync(sessionLogDir, { recursive: true });
    // Snapshot pre-existing logs so we only attribute files created by THIS run —
    // the real log dir is shared across all repos/worktrees (the #198 cross-talk source).
    const preexistingLogs = this.snapshotLogFiles(sessionLogDir);

    const start = Date.now();
    let outcome: AgentInvocationResult['outcome'] = 'success';
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    let contractViolations: string[] = [];
    let watchdogInterval: NodeJS.Timeout | null = null;
    let timeoutSignal: AbortSignal | undefined;
    let isCanceled = false;
    let postExit: {
      quotaMatch: string | null;
      providerMatch: string | null;
      transcript: string;
    } | null = null;
    try {
      timeoutSignal =
        this.opts.timeoutMsDefault !== undefined
          ? AbortSignal.timeout(this.opts.timeoutMsDefault)
          : undefined;
      const signals: AbortSignal[] = [];
      if (timeoutSignal) signals.push(timeoutSignal);
      if (request.abortSignal) signals.push(request.abortSignal);
      const cancelSignal =
        signals.length === 1
          ? signals[0]
          : signals.length > 1
            ? AbortSignal.any(signals)
            : undefined;
      const args = ['run'];
      if (request.model) {
        const modelArg = request.provider ? `${request.provider}/${request.model}` : request.model;
        args.push('--model', modelArg);
      }
      // OPENCODE_SESSION_LOG_DIR is a no-op for real opencode (it derives the log
      // dir from XDG_DATA_HOME). We still pass it so the test fixtures — which
      // stand in for opencode and DO honor it — write to the dir we scan. In
      // production it is harmless: opencode writes to sessionLogDir anyway.
      const childEnv: Record<string, string | undefined> = {
        OPENCODE_SESSION_LOG_DIR: sessionLogDir,
        PWD: request.cwd,
        INIT_CWD: undefined,
      };
      const child = execa(bin, args, {
        cwd: request.cwd,
        reject: false,
        all: false,
        input: readFileSync(request.promptPath, 'utf-8'),
        ...(cancelSignal ? { cancelSignal } : {}),
        env: childEnv,
      });

      if (child.stdout) {
        child.stdout.pipe(process.stdout);
      }

      watchdogInterval = this.startWatchdog(
        child as ReturnType<typeof execa>,
        sessionLogDir,
        preexistingLogs,
        request.cwd,
        (match: string, type: 'quota' | 'provider') => {
          watchdogKilled = true;
          watchdogKilledType = type;
          watchdogMatch = match;
        },
      );

      const r = await child;
      if (watchdogInterval !== null) clearInterval(watchdogInterval);

      postExit = this.scanSessionLogsPostExit(sessionLogDir, preexistingLogs, request.cwd);

      stdout = r.stdout ?? '';
      stderr = r.stderr ?? '';
      exitCode = r.exitCode ?? 0;
      isCanceled = r.isCanceled;

      if (!watchdogKilled && postExit.quotaMatch) {
        watchdogKilled = true;
        watchdogKilledType = 'quota';
        watchdogMatch = postExit.quotaMatch;
      }
      if (!watchdogKilled && watchdogKilledType === null && postExit.providerMatch) {
        watchdogKilled = true;
        watchdogKilledType = 'provider';
        watchdogMatch = postExit.providerMatch;
      }
    } catch (e) {
      if (watchdogInterval !== null) clearInterval(watchdogInterval);
      outcome = 'failed';
      exitCode = 1;
      stderr = String((e as Error).message);
    }

    const durationMs = Date.now() - start;
    let endCommitSha: string | undefined;
    try {
      endCommitSha = execSync('git rev-parse HEAD', { cwd: request.cwd }).toString().trim();
    } catch {
      contractViolations = [...contractViolations, 'missing_commit'];
    }

    let stderrForLog = stderr;
    if (watchdogKilled) {
      outcome = 'failed';
      if (watchdogKilledType === 'quota') {
        contractViolations = [CONTRACT_VIOLATION_CODES.PROVIDER_ERROR];
        stderr = `QUOTA_EXCEEDED: ${watchdogMatch}`;
        stderrForLog = `QUOTA_EXCEEDED: ${watchdogMatch}\n${stderrForLog}`;
      } else {
        contractViolations = [CONTRACT_VIOLATION_CODES.PROVIDER_ERROR];
        const quotaLine = testQuotaPatterns(watchdogMatch);
        if (quotaLine) {
          stderr = `QUOTA_EXCEEDED: ${quotaLine}`;
          stderrForLog = `QUOTA_EXCEEDED: ${quotaLine}\n${stderrForLog}`;
        } else {
          stderr = `PROVIDER_ERROR: ${watchdogMatch}`;
          stderrForLog = `PROVIDER_ERROR: ${watchdogMatch}\n${stderrForLog}`;
        }
      }
    } else if (isCanceled) {
      if (timeoutSignal?.aborted && !request.abortSignal?.aborted) {
        outcome = 'timeout';
      } else {
        outcome = 'failed';
        contractViolations = [CONTRACT_VIOLATION_CODES.CANCELLED_BY_ORCHESTRATOR];
      }
    } else if (exitCode !== 0) {
      // Plain non-zero exit. Provider/quota classification is NOT done here: any
      // session-log provider/quota match is promoted to watchdogKilled above (see
      // the postExit promotion) and handled in the `if (watchdogKilled)` branch,
      // so by this point postExit holds no match. We never scan the process stderr
      // (the agent transcript) — that's the #250/#255 false-positive source.
      outcome = 'failed';
    } else if (outcome === 'success') {
      // The agent exited 0 (success). We deliberately do NOT scan the captured
      // process stderr for provider/quota errors here: stderr is the agent TUI
      // transcript, and a task that works on error-handling code/fixtures
      // legitimately prints provider-error-shaped strings — both unstructured
      // ("429" in a `git log`) and structurally valid (`ERROR …T… AI_APICallError`)
      // — so scanning it discards completed work (#250).
      //
      // Real provider/quota errors are detected upstream from opencode's own
      // session-log files (scanSessionLogsPostExit → watchdogKilled, see lines
      // ~97-123); if one fired we'd be in the watchdogKilled branch, not here.
      // A provider error that surfaces ONLY on stderr (not the session log) is
      // given up; the NO_OUTPUT heuristic below and downstream validation are the
      // safety net.
      if (
        request.phaseId.startsWith('implement') &&
        request.startCommitSha &&
        endCommitSha === request.startCommitSha &&
        stdout.trim().length === 0
      ) {
        outcome = 'contract_violation';
        contractViolations = [CONTRACT_VIOLATION_CODES.NO_OUTPUT];
        stderr = 'NO_OUTPUT: agent exited 0 with empty stdout and no git changes';
        stderrForLog = `NO_OUTPUT: agent exited 0 with empty stdout and no git changes\n${stderrForLog}`;
      }
    }
    let remediatedArtifacts: { src: string; artifact: string }[] | undefined;
    if (outcome === 'success' && request.expectedArtifacts?.length) {
      for (const artifact of request.expectedArtifacts) {
        const artifactPath = join(request.cwd, artifact);
        if (!existsSync(artifactPath)) {
          outcome = 'contract_violation';
          contractViolations = [
            ...contractViolations,
            CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
          ];
          stderrForLog = `MISSING_REQUIRED_ARTIFACT: ${artifact}\n${stderrForLog}`;
          break;
        }
      }
      if (
        outcome === 'contract_violation' &&
        contractViolations.includes(CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT)
      ) {
        const remediateOpts = {
          cwd: request.cwd,
          startMs: start,
          expectedArtifacts: request.expectedArtifacts,
          stderrForLog,
        };
        const resultCwd = remediateMissingArtifacts(remediateOpts);
        stderrForLog = remediateOpts.stderrForLog;
        remediatedArtifacts = resultCwd.remediatedArtifacts;

        let missing = resultCwd.missingArtifacts;
        if (this.opts.repoRoot && missing.length > 0) {
          // Also scan repoRoot for artifacts that drifted outside the worktree (#311).
          // Uses copyOnly: true because repoRoot is shared across concurrent runs.
          // Freshness is guaranteed by startMs check in remediateMissingArtifacts.
          const repoOpts = {
            cwd: request.cwd,
            startMs: start,
            expectedArtifacts: missing,
            stderrForLog,
            sourceDir: this.opts.repoRoot,
            copyOnly: true,
          };
          const resultRepo = remediateMissingArtifacts(repoOpts);
          stderrForLog = repoOpts.stderrForLog;
          remediatedArtifacts = [...remediatedArtifacts, ...resultRepo.remediatedArtifacts];
          missing = resultRepo.missingArtifacts;
        }

        if (remediatedArtifacts.length > 0) {
          if (missing.length === 0) {
            outcome = 'success';
            contractViolations = contractViolations
              .filter((v) => v !== CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT)
              .concat(CONTRACT_VIOLATION_CODES.MISPLACED_ARTIFACT);
            const remediatedList = remediatedArtifacts
              .map((r) => `${r.src} → ${r.artifact}`)
              .join(', ');
            stderrForLog = `MISPLACED_ARTIFACT: auto-remediated ${remediatedList}\n${stderrForLog}`;
          }
        }
      }
    }
    // opencode emits its transcript to its session log, not to stdout/stderr, so
    // the captured streams are usually empty — which left phase logs at 0 bytes and
    // failures undebuggable (#255). Surface the session-log transcript via stdoutPath
    // (run-agent streams stdoutPath/stderrPath into the orchestrator's phase log)
    // when the process produced no stdout of its own.
    const transcript = stdout.trim().length > 0 ? stdout : (postExit?.transcript ?? '');
    writeFileSync(stdoutPath, transcript);
    writeFileSync(stderrPath, stderrForLog);

    // Parse token usage from the session log transcripts
    const usage = postExit?.transcript
      ? parseSessionLogUsage(OpenCodeAgentAdapter.providerLines(postExit.transcript))
      : undefined;

    const ret: AgentInvocationResult = {
      runtime: 'opencode',
      provider: request.provider ?? '',
      model: request.model ?? '',
      exitCode,
      durationMs,
      stdoutPath,
      stderrPath,
      contractViolations,
      outcome,
      ...(usage ? { usage: { ...usage } } : {}),
    };
    if (endCommitSha) ret.endCommitSha = endCommitSha;
    if (request.stepId) ret.stepId = request.stepId;
    if (remediatedArtifacts) ret.remediatedArtifacts = remediatedArtifacts;
    // Set resultJsonPath so downstream extraction uses the explicit path rather
    // than falling back to a hardcoded 'result.json' (#311).
    if (ret.outcome === 'success' && request.expectedArtifacts.includes('result.json')) {
      const artifactPath = join(request.cwd, 'result.json');
      if (existsSync(artifactPath)) {
        ret.resultJsonPath = 'result.json';
      }
    }
    return ret;
  }

  // Filenames of *.log present in the shared log dir before we spawned opencode.
  private snapshotLogFiles(dir: string): Set<string> {
    try {
      return new Set(readdirSync(dir).filter((f) => f.endsWith('.log')));
    } catch {
      return new Set();
    }
  }

  // Log files created by THIS invocation: new since the pre-spawn snapshot. The
  // log dir is shared across all repos/worktrees, so when concurrent invocations
  // create several, prefer the ones whose content references this invocation's
  // cwd (the #198 cross-talk disambiguator). If none match (e.g. opencode logged
  // a different cwd — see #249), fall back to all new files rather than attributing
  // to nothing.
  private candidateLogFiles(dir: string, preexisting: Set<string>, cwd: string): string[] {
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith('.log') && !preexisting.has(f));
    } catch {
      return [];
    }
    if (names.length <= 1) return names.map((f) => join(dir, f));
    const cwdMatches = names.filter((f) => {
      try {
        return readFileSync(join(dir, f), 'utf-8').includes(cwd);
      } catch {
        return false;
      }
    });
    return (cwdMatches.length > 0 ? cwdMatches : names).map((f) => join(dir, f));
  }

  // Restrict scanned text to opencode's provider/LLM diagnostic lines so detection
  // keys on opencode's own runtime responses (real 429s, auth failures), never on
  // agent transcript content that happens to contain error-shaped strings (#255).
  private static providerLines(content: string): string {
    return content
      .split('\n')
      .filter((l) => PROVIDER_LOG_SERVICES.test(l))
      .join('\n');
  }

  private scanSessionLogsPostExit(
    sessionLogDir: string,
    preexisting: Set<string>,
    cwd: string,
  ): {
    quotaMatch: string | null;
    providerMatch: string | null;
    transcript: string;
  } {
    let quotaMatch: string | null = null;
    let providerMatch: string | null = null;
    const transcripts: string[] = [];

    for (const logPath of this.candidateLogFiles(sessionLogDir, preexisting, cwd)) {
      try {
        const raw = readFileSync(logPath, 'utf-8');
        if (!raw) continue;
        // Keep the full log for the phase-log transcript (observability, #255);
        // detection only looks at provider/LLM diagnostic lines.
        transcripts.push(raw);
        const content = OpenCodeAgentAdapter.providerLines(raw);
        if (!content) continue;
        if (!quotaMatch) {
          quotaMatch = testQuotaPatterns(content, { structuralOnly: true });
        }
        if (!providerMatch) {
          providerMatch = testProviderErrorPatterns(content, { structuralOnly: true });
        }
      } catch {
        // File might be deleted between readdir and read — ignore
      }
    }

    return { quotaMatch, providerMatch, transcript: transcripts.join('\n') };
  }

  private startWatchdog(
    child: ReturnType<typeof execa>,
    sessionLogDir: string,
    preexisting: Set<string>,
    cwd: string,
    onKilled: (match: string, type: 'quota' | 'provider') => void,
  ): NodeJS.Timeout | null {
    const pollMs = this.opts.quotaPollMs ?? 2000;
    const logOffsets = new Map<string, number>();

    return setInterval(() => {
      for (const logPath of this.candidateLogFiles(sessionLogDir, preexisting, cwd)) {
        try {
          const prevOffset = logOffsets.get(logPath) ?? 0;
          const size = statSync(logPath).size;
          if (size <= prevOffset) continue;

          const buf = readFileSync(logPath);
          logOffsets.set(logPath, buf.length);
          const content = OpenCodeAgentAdapter.providerLines(
            buf.subarray(prevOffset).toString('utf-8'),
          );
          if (!content) continue;

          const quotaMatch = testQuotaPatterns(content, { structuralOnly: true });
          if (quotaMatch) {
            onKilled(quotaMatch, 'quota');
            child.kill('SIGKILL');
            return;
          }
          const providerMatch = testProviderErrorPatterns(content, { structuralOnly: true });
          if (providerMatch) {
            onKilled(providerMatch, 'provider');
            child.kill('SIGKILL');
            return;
          }
        } catch {
          // File might be deleted between readdir and read — ignore
        }
      }
    }, pollMs);
  }
}
