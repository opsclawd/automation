import type { PhaseName, Failure } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError, type Artifact } from '../../ports/artifact-store.js';
import type { ArtifactGuardPort } from '../../ports/git-port.js';

export interface CreatePrHandlerOpts {
  headBranch: (ctx: PhaseHandlerContext) => string;
}

export class CreatePrHandler implements PhaseHandler {
  readonly phase = 'create-pr' as PhaseName;
  constructor(private readonly opts: CreatePrHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('create_pr.started', 'info', 'starting create-pr');

    const writtenArtifacts: string[] = [];

    // ── Stage 0: Hard gate — validation must pass before creating a PR (#514) ──
    let validationResult: string | undefined;
    try {
      const raw = await ctx.artifacts.read(ctx.runUuid, 'validation.result');
      validationResult = raw.trim().split('\n')[0];
    } catch {
      validationResult = undefined;
    }
    if (validationResult !== 'passed') {
      const msg = `Validation did not pass (status: ${validationResult || 'missing'}). PR creation blocked.`;
      emit('create_pr.blocked', 'error', msg);
      return this._fail(
        ctx,
        'validation_failed',
        msg,
        false,
        'Re-run the issue to fix validation failures before creating a PR.',
        writtenArtifacts,
      );
    }

    // ── Stage 1: Idempotency — reuse existing PR if pr-url.txt exists ──
    let prUrl: string | undefined;
    try {
      prUrl = (await ctx.artifacts.read(ctx.runUuid, 'pr-url.txt')).trim();
    } catch (e) {
      if (e instanceof ArtifactNotFoundError) {
        prUrl = undefined;
      } else {
        const msg = `failed to read pr-url.txt: ${(e as Error).message}`;
        emit('create_pr.failed', 'error', msg);
        return this._fail(
          ctx,
          'command_failed',
          msg,
          false,
          'Check artifact store health and resume create-pr.',
          writtenArtifacts,
        );
      }
    }

    if (prUrl) {
      const prNumber = _parsePrNumber(prUrl);
      if (prNumber === undefined) {
        const msg = `invalid pr-url.txt artifact content: ${prUrl}`;
        emit('create_pr.failed', 'error', msg);
        return this._fail(
          ctx,
          'github_failed',
          msg,
          false,
          'Fix or remove pr-url.txt artifact and resume.',
          writtenArtifacts,
        );
      }

      let existingPr;
      try {
        existingPr = await ctx.github.getPr(ctx.repoFullName, prNumber);
      } catch (e) {
        const msg = `failed to inspect pull request #${prNumber} referenced by pr-url.txt: ${(e as Error).message}`;
        emit('create_pr.failed', 'error', msg);
        return this._fail(
          ctx,
          'github_failed',
          msg,
          true,
          'Verify GitHub API access or PR existence; resume create-pr.',
          writtenArtifacts,
        );
      }

      if (existingPr.state === 'open') {
        emit('pr.reused', 'info', `reusing existing PR url ${prUrl}`, { url: prUrl });
        try {
          await ctx.github.updateIssueLabels(ctx.repoFullName, ctx.issueNumber, {
            remove: ['ai:in-progress'],
            add: ['ai:pr-ready'],
          });
        } catch (e) {
          const msg = `failed to update issue labels: ${(e as Error).message}`;
          emit('github.label_update_failed', 'error', msg);
          emit('create_pr.failed', 'error', msg);
          return this._fail(
            ctx,
            'github_failed',
            msg,
            true,
            "Restore the issue's expected label state and resume create-pr.",
            writtenArtifacts,
          );
        }
        emit('create_pr.completed', 'info', 'create-pr complete');
        return { outcome: 'passed' };
      }

      emit(
        'pr.stale',
        'info',
        `existing PR #${existingPr.number} at ${prUrl} is ${existingPr.state}; creating replacement PR`,
        { number: existingPr.number, url: prUrl, state: existingPr.state },
      );
    }

    // ── Stage 2: Deterministic PR summary assembly ──
    const summary = await _assemblePrSummary(ctx);

    // Write pr-summary.md
    try {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: 'create-pr',
        relativePath: 'pr-summary.md',
        contents: summary,
      });
      writtenArtifacts.push('pr-summary.md');
    } catch (e) {
      const msg = `failed to write pr-summary.md: ${(e as Error).message}`;
      emit('create_pr.failed', 'error', msg);
      return this._fail(
        ctx,
        'command_failed',
        msg,
        false,
        'Check artifact store and resume.',
        writtenArtifacts,
      );
    }

    // ── Stage 3: Branch hygiene before deterministic GitHub operations ──
    const headBranch = this.opts.headBranch(ctx);
    const baseBranch = ctx.baseBranch ?? 'main';

    // Clean up orchestrator artifacts now that the PR body has been assembled.
    // Non-fatal: cleanup failure does not block the run outcome.
    try {
      const gitGuard = ctx.git as Partial<ArtifactGuardPort>;
      if (typeof gitGuard.cleanOrchestratorArtifacts === 'function') {
        await gitGuard.cleanOrchestratorArtifacts(ctx.cwd, baseBranch);
      }
    } catch {
      // ignore
    }

    let fullyMerged = false;
    try {
      fullyMerged = await ctx.git.isAncestor(ctx.cwd, headBranch, baseBranch);
    } catch (e) {
      const msg = `failed to check branch ancestry for ${headBranch} against ${baseBranch}: ${(e as Error).message}`;
      emit('create_pr.failed', 'error', msg);
      return this._fail(
        ctx,
        'git_failed',
        msg,
        true,
        'Verify local refs and git repository state, then resume create-pr.',
        writtenArtifacts,
      );
    }

    if (fullyMerged) {
      const msg = `head branch ${headBranch} is already contained in base branch ${baseBranch} (no new commits)`;
      emit('create_pr.failed', 'error', msg);
      return this._fail(
        ctx,
        'git_failed',
        msg,
        false,
        'Add new commits to the head branch or stop the Run.',
        writtenArtifacts,
      );
    }

    const title = _firstHeadingOrLine(summary, ctx.issueNumber);

    // Push the branch so gh pr create's --head ref exists on remote.
    try {
      await ctx.git.push({ cwd: ctx.cwd, branch: headBranch });
    } catch (e) {
      const msg = `failed to push branch ${headBranch}: ${(e as Error).message}`;
      emit('create_pr.failed', 'error', msg);
      return this._fail(
        ctx,
        'git_failed',
        msg,
        true,
        'Check git remote/auth state; resume create-pr.',
        writtenArtifacts,
      );
    }

    try {
      const pr = await ctx.github.createPullRequest({
        repoFullName: ctx.repoFullName,
        baseBranch,
        headBranch,
        title,
        body: summary,
      });
      prUrl = pr.url;
      emit('pr.created', 'info', `opened PR ${pr.number}`, { number: pr.number, url: pr.url });
    } catch (e) {
      const msg = `failed to create PR: ${(e as Error).message}`;
      emit('create_pr.failed', 'error', msg);
      return this._fail(
        ctx,
        'github_failed',
        msg,
        true,
        'Check gh auth/branch state; resume create-pr.',
        writtenArtifacts,
      );
    }

    // Write pr-url.txt artifact immediately after PR creation so resume is idempotent if labels fail.
    try {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: 'create-pr',
        relativePath: 'pr-url.txt',
        contents: prUrl + '\n',
      });
      writtenArtifacts.push('pr-url.txt');
    } catch (e) {
      const msg = `failed to write pr-url.txt: ${(e as Error).message}`;
      emit('create_pr.failed', 'error', msg);
      return this._fail(
        ctx,
        'command_failed',
        msg,
        false,
        `PR created at ${prUrl} but pr-url.txt write failed. Verify PR and record URL manually, then resume.`,
        writtenArtifacts,
      );
    }

    // Update issue labels (fatal on failure; resume safe because pr-url.txt is already written)
    try {
      await ctx.github.updateIssueLabels(ctx.repoFullName, ctx.issueNumber, {
        remove: ['ai:in-progress'],
        add: ['ai:pr-ready'],
      });
    } catch (e) {
      const msg = `failed to update issue labels: ${(e as Error).message}`;
      emit('github.label_update_failed', 'error', msg);
      emit('create_pr.failed', 'error', msg);
      return this._fail(
        ctx,
        'github_failed',
        msg,
        true,
        "Restore the issue's expected label state and resume create-pr.",
        writtenArtifacts,
      );
    }

    emit('create_pr.completed', 'info', 'create-pr complete');
    return { outcome: 'passed' };
  }

  private _fail(
    ctx: PhaseHandlerContext,
    kind: Failure['kind'],
    message: string,
    canRetry: boolean,
    suggestedAction: string,
    artifacts: string[] = [],
  ): PhaseResult {
    return {
      outcome: 'failed',
      failure: {
        runUuid: ctx.runUuid,
        phase: this.phase,
        kind,
        message,
        canRetry,
        suggestedAction,
        artifacts,
        detectedAt: ctx.now(),
      },
    };
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

async function _assemblePrSummary(ctx: PhaseHandlerContext): Promise<string> {
  // Issue title: try GitHub API, fall back to generic string
  let issueTitle = `Resolve issue #${ctx.issueNumber}`;
  try {
    const issue = await ctx.github.getIssue(ctx.repoFullName, ctx.issueNumber);
    issueTitle = issue.title;
  } catch {
    // non-fatal — fallback title is acceptable
  }

  // Implementation summary paragraph
  let prSummary = '';
  try {
    const implLog = await ctx.artifacts.read(ctx.runUuid, 'implementation-log.md');
    prSummary = _extractSummaryParagraph(implLog);
  } catch {
    // optional artifact
  }

  // Task list: prefer task-manifest.json, fall back to plan.md headers
  let prTasks = '';
  try {
    const manifestJson = await ctx.artifacts.read(ctx.runUuid, 'task-manifest.json');
    prTasks = _extractTasksFromManifest(manifestJson);
  } catch {
    // try plan.md fallback
  }
  if (!prTasks) {
    try {
      const planText = await ctx.artifacts.read(ctx.runUuid, 'plan.md');
      prTasks = _extractTasksFromPlan(planText);
    } catch {
      // optional
    }
  }

  // Git diff stat
  let prChanges = '';
  if (ctx.startCommitSha) {
    try {
      prChanges = await ctx.git.diffStat(ctx.cwd, ctx.startCommitSha, 'HEAD');
    } catch {
      // non-fatal
    }
  }

  // Validation result
  let prValidation = 'Unknown';
  try {
    const result = await ctx.artifacts.read(ctx.runUuid, 'validation.result');
    prValidation = result.trim().split('\n')[0] ?? 'Unknown';
  } catch {
    // optional
  }

  let prValidationSteps = '';
  try {
    const validateLog = await ctx.artifacts.read(ctx.runUuid, 'validate.log');
    prValidationSteps = _parseValidationSteps(validateLog);
  } catch {
    // optional
  }

  // Review findings
  let prReview = 'No code review performed';
  try {
    const reviewText = await ctx.artifacts.read(ctx.runUuid, 'code-review.md');
    prReview = _parseReviewFindings(reviewText);
  } catch {
    try {
      const reviewText = await ctx.artifacts.read(ctx.runUuid, 'review.md');
      prReview = _parseReviewFindings(reviewText);
    } catch {
      // neither artifact present
    }
  }

  // Arbiter rationale and deviation records
  let allArtifacts: Artifact[] = [];
  try {
    allArtifacts = await ctx.artifacts.list(ctx.runUuid);
  } catch {
    // non-fatal — autonomous actions section is optional
  }
  const arbiterFiles = allArtifacts
    .filter((a) => /^arbiter-rationale-.+\.md$/.test(a.relativePath))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const deviationFiles = allArtifacts
    .filter((a) => /^deviation-record-.+\.md$/.test(a.relativePath))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  let prAutonomousActions = '';
  for (const arb of arbiterFiles) {
    try {
      const taskRef = arb.relativePath.replace(/^arbiter-rationale-/, '').replace(/\.md$/, '');
      const contents = await ctx.artifacts.read(ctx.runUuid, arb.relativePath);
      prAutonomousActions += `### Arbiter Rationale (Task ${taskRef})\n${contents}\n`;
    } catch {
      // skip unreadable
    }
  }
  for (const dev of deviationFiles) {
    try {
      const taskRef = dev.relativePath.replace(/^deviation-record-/, '').replace(/\.md$/, '');
      const contents = await ctx.artifacts.read(ctx.runUuid, dev.relativePath);
      prAutonomousActions += `### Deviation Record (Task ${taskRef})\n${contents}\n`;
    } catch {
      // skip unreadable
    }
  }
  if (prAutonomousActions) {
    prAutonomousActions = `## Autonomous Actions\n${prAutonomousActions}`;
  }

  // Assemble — match legacy heredoc exactly (lines 4719–4741 of ai-run-issue-v2)
  const parts: string[] = [`# ${issueTitle}`, '', `Closes #${ctx.issueNumber}`, ''];
  if (prSummary) parts.push(prSummary, '');
  parts.push('## Tasks', prTasks || '- None', '');
  parts.push('## Changes', prChanges || '- None', '');
  parts.push(`## Validation: ${prValidation}`);
  if (prValidationSteps) parts.push(prValidationSteps);
  parts.push('');
  parts.push('## Review Findings', prReview, '');
  if (prAutonomousActions) parts.push(prAutonomousActions, '');
  parts.push('## Artifacts', `Run logs and artifacts: \`ai/issues/${ctx.issueNumber}/\``);

  let body = parts.join('\n');
  if (Buffer.byteLength(body, 'utf-8') > MAX_PR_BODY_BYTES) {
    body = _truncateBody(body);
  }
  return body;
}

/** Extract the first non-empty paragraph starting from line 2 of the impl log.
 *  Equivalent to: awk 'NR==2,/^$/ {if (/^$/) exit; print}' */
function _extractSummaryParagraph(implLog: string): string {
  const lines = implLog.split('\n');
  const result: string[] = [];
  let started = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!started && line.trim() === '') continue;
    if (!started) started = true;
    if (line.trim() === '') break;
    result.push(line);
  }
  return result.join('\n');
}

/** Parse task titles from task-manifest.json and return as markdown bullet list. */
function _extractTasksFromManifest(manifestJson: string): string {
  try {
    const manifest = JSON.parse(manifestJson) as { tasks?: Array<{ title?: string }> };
    const tasks = manifest.tasks ?? [];
    return tasks
      .map((t) => t.title?.trim())
      .filter((t): t is string => Boolean(t))
      .map((t) => `- ${t}`)
      .join('\n');
  } catch {
    return '';
  }
}

/** Fallback: extract ### Task N: headers from plan.md as bullet list.
 *  Equivalent to: awk '/^#{2,3} Task [0-9]+:/ {sub(/^#{2,3} /, "- "); print}' */
function _extractTasksFromPlan(planText: string): string {
  return planText
    .split('\n')
    .filter((l) => /^#{2,3} Task \d+:/.test(l))
    .map((l) => l.replace(/^#{2,3} /, '- '))
    .join('\n');
}

/** Parse validate.log sentinel markers into per-step pass/fail lines.
 *  Sentinels: "=== <step> ===" opens a step; "[<step> failed]" or
 *  "[install completed with warnings]" closes it as failed; EOF closes as passed. */
function _parseValidationSteps(validateLog: string): string {
  const lines = validateLog.split('\n');
  let phaseName = '';
  const results: string[] = [];
  const failPattern = /^\[(build|lint|typecheck|test|install) failed\]$/;

  for (const line of lines) {
    const stepMatch = line.match(/^=== (.+) ===$/);
    if (stepMatch) {
      if (phaseName) results.push(`- ${phaseName}: passed`);
      phaseName = stepMatch[1]!;
    } else if (phaseName && line === '[install completed with warnings]') {
      results.push(`- ${phaseName}: warning`);
      phaseName = '';
    } else if (phaseName && failPattern.test(line) && line.startsWith(`[${phaseName}`)) {
      results.push(`- ${phaseName}: failed`);
      phaseName = '';
    }
  }
  if (phaseName) results.push(`- ${phaseName}: passed`);

  return results.join('\n');
}

/** Count Critical/High and Medium/Low severity findings in a review file. */
function _parseReviewFindings(reviewText: string): string {
  const critHigh = (reviewText.match(/- severity:\s*(critical|high)\b/gim) ?? []).length;
  const mediLow = (reviewText.match(/- severity:\s*(medium|low)\b/gim) ?? []).length;
  return `- Critical/High: ${critHigh}\n- Medium/Low: ${mediLow}`;
}

// GitHub PR body limit is 256 KB; stay well under to leave room for GitHub's response envelope.
const MAX_PR_BODY_BYTES = 240_000;

export function _truncateBody(body: string, maxBytesOverride?: number): string {
  const footer =
    '\n\n---\n> PR body truncated to fit within GitHub size limits. Some artifact content omitted.';

  const maxBytes = (maxBytesOverride ?? MAX_PR_BODY_BYTES) - Buffer.byteLength(footer, 'utf-8');

  // Try stripping autonomous actions section first (most variable)
  let candidate = _removeSection(body, '## Autonomous Actions');
  if (Buffer.byteLength(candidate, 'utf-8') <= maxBytes) {
    return candidate + footer;
  }

  // Then try stripping the review findings section
  candidate = _removeSection(candidate, '## Review Findings');
  if (Buffer.byteLength(candidate, 'utf-8') <= maxBytes) {
    return candidate + footer;
  }

  // Then try stripping validation steps
  candidate = _removeValidationSteps(candidate);
  if (Buffer.byteLength(candidate, 'utf-8') <= maxBytes) {
    return candidate + footer;
  }

  // Last resort: character-level truncation at a line boundary
  let result = candidate;
  while (Buffer.byteLength(result, 'utf-8') > maxBytes) {
    result = result.slice(0, Math.floor(result.length * 0.9));
    const nl = result.lastIndexOf('\n');
    if (nl > 0) result = result.slice(0, nl);
  }
  return result + footer;
}

/** Remove a section header and all content until the next section header or EOF. */
export function _removeSection(body: string, header: string): string {
  let idx = -1;
  if (body.startsWith(`${header}\n`) || body === header) {
    idx = 0;
  } else {
    const found = body.indexOf(`\n${header}\n`);
    if (found !== -1) {
      idx = found + 1;
    } else {
      const eofFound = body.indexOf(`\n${header}`);
      if (eofFound !== -1 && eofFound + 1 + header.length === body.length) {
        idx = eofFound + 1;
      }
    }
  }

  if (idx === -1) return body;

  const before = body.slice(0, idx).trimEnd();
  const headerLineEnd = body.indexOf('\n', idx);

  if (headerLineEnd === -1) {
    return before;
  }

  const remaining = body.slice(headerLineEnd);
  const nextHeaderOffset = remaining.search(/\n## /);
  if (nextHeaderOffset === -1) {
    return before;
  }

  const nextSection = remaining.slice(nextHeaderOffset + 1);
  return before ? `${before}\n\n${nextSection}` : nextSection;
}

/** Remove all ## Validation: steps content between the header status line and the next ## header or EOF. */
export function _removeValidationSteps(body: string): string {
  let idx = -1;
  if (body.startsWith('## Validation:')) {
    idx = 0;
  } else {
    const found = body.indexOf('\n## Validation:');
    if (found !== -1) {
      idx = found + 1;
    }
  }

  if (idx === -1) return body;

  const headerLineEnd = body.indexOf('\n', idx);
  if (headerLineEnd === -1) {
    return body;
  }

  const headerLine = body.slice(0, headerLineEnd);
  const remaining = body.slice(headerLineEnd);

  const nextHeaderOffset = remaining.search(/\n## /);
  if (nextHeaderOffset === -1) {
    return headerLine.trimEnd();
  }

  const nextSection = remaining.slice(nextHeaderOffset + 1);
  return `${headerLine.trimEnd()}\n\n${nextSection}`;
}

function _firstHeadingOrLine(summary: string, issueNumber: number): string {
  const heading = summary.split('\n').find((l) => l.startsWith('#'));
  if (heading) return heading.replace(/^#+\s*/, '').trim();
  const firstLine = summary.split('\n').find((l) => l.trim().length > 0);
  return firstLine?.trim() ?? `Resolve issue #${issueNumber}`;
}

function _parsePrNumber(prUrl: string): number | undefined {
  try {
    const parsed = new URL(prUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    const match = parsed.pathname.match(/\/pull\/([1-9]\d*)\/?$/);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}
