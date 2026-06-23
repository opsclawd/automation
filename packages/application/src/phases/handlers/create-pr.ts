import type { PhaseName, Failure } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError, type Artifact } from '../../ports/artifact-store.js';

export interface CreatePrHandlerOpts {
  baseBranch: string;
  headBranch: (ctx: PhaseHandlerContext) => string;
}

export class CreatePrHandler implements PhaseHandler {
  readonly phase = 'create-pr' as PhaseName;
  constructor(private readonly opts: CreatePrHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('create_pr.started', 'info', 'starting create-pr');

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
        );
      }
    }

    if (prUrl) {
      emit('pr.reused', 'info', `reusing existing PR url ${prUrl}`, { url: prUrl });
      try {
        await ctx.github.updateIssueLabels(ctx.repoFullName, ctx.issueNumber, {
          remove: ['ai:in-progress'],
          add: ['ai:pr-ready'],
        });
      } catch (e) {
        emit('github.label_update_failed', 'warn', `label update failed: ${(e as Error).message}`);
      }
      emit('create_pr.completed', 'info', 'create-pr complete');
      return { outcome: 'passed' };
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
    } catch (e) {
      const msg = `failed to write pr-summary.md: ${(e as Error).message}`;
      emit('create_pr.failed', 'error', msg);
      return this._fail(ctx, 'command_failed', msg, false, 'Check artifact store and resume.');
    }

    // ── Stage 3: Deterministic GitHub operations ──
    const title = _firstHeadingOrLine(summary, ctx.issueNumber);

    // Push the branch so gh pr create's --head ref exists on remote.
    try {
      await ctx.git.push({ cwd: ctx.cwd, branch: this.opts.headBranch(ctx) });
    } catch (e) {
      const msg = `failed to push branch ${this.opts.headBranch(ctx)}: ${(e as Error).message}`;
      emit('create_pr.failed', 'error', msg);
      return this._fail(
        ctx,
        'git_failed',
        msg,
        true,
        'Check git remote/auth state; resume create-pr.',
      );
    }

    try {
      const pr = await ctx.github.createPullRequest({
        repoFullName: ctx.repoFullName,
        baseBranch: this.opts.baseBranch,
        headBranch: this.opts.headBranch(ctx),
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
      );
    }

    // Update issue labels (non-fatal on failure)
    try {
      await ctx.github.updateIssueLabels(ctx.repoFullName, ctx.issueNumber, {
        remove: ['ai:in-progress'],
        add: ['ai:pr-ready'],
      });
    } catch (e) {
      emit('github.label_update_failed', 'warn', `label update failed: ${(e as Error).message}`);
    }

    // Write pr-url.txt artifact. PR is already created on GitHub at this point;
    // retrying would produce a duplicate, so canRetry: false is required.
    try {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        phaseId: 'create-pr',
        relativePath: 'pr-url.txt',
        contents: prUrl + '\n',
      });
    } catch (e) {
      const msg = `failed to write pr-url.txt: ${(e as Error).message}`;
      emit('create_pr.failed', 'error', msg);
      return this._fail(
        ctx,
        'command_failed',
        msg,
        false,
        `PR created at ${prUrl} but pr-url.txt write failed. Verify PR and record URL manually, then resume.`,
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
        artifacts: ['pr-summary.md'],
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
    } else if (phaseName && failPattern.test(line)) {
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

function _truncateBody(body: string): string {
  const footer =
    '\n\n---\n> PR body truncated to fit within GitHub size limits. Some artifact content omitted.';

  const maxBytes = MAX_PR_BODY_BYTES - Buffer.byteLength(footer, 'utf-8');

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
  let result = body;
  while (Buffer.byteLength(result, 'utf-8') > maxBytes) {
    result = result.slice(0, Math.floor(result.length * 0.9));
    const nl = result.lastIndexOf('\n');
    if (nl > 0) result = result.slice(0, nl);
  }
  return result + footer;
}

/** Remove a section header and all content until the next section header or EOF. */
function _removeSection(body: string, header: string): string {
  const idx = body.indexOf(`\n${header}\n`);
  if (idx === -1) return body;
  const afterHeader = body.indexOf('\n', idx + header.length + 2);
  if (afterHeader === -1) return body.slice(0, Math.max(0, idx)).trimEnd();

  const remaining = body.slice(afterHeader + 1);
  const nextHeader = remaining.search(/\n## /);
  const end = nextHeader === -1 ? remaining.length : nextHeader + 1;
  return body.slice(0, Math.max(0, idx)).trimEnd() + remaining.slice(end);
}

/** Remove all ## Validation: content between the header and the next ## header or EOF. */
function _removeValidationSteps(body: string): string {
  const idx = body.indexOf('\n## Validation:');
  if (idx === -1) return body;
  const afterHeader = body.indexOf('\n', idx + 1);
  if (afterHeader === -1) return body.slice(0, Math.max(0, idx)).trimEnd();

  // After the validation status line, look for either '## Review Findings' or EOF
  const remaining = body.slice(afterHeader + 1);
  const nextSection = remaining.search(/\n## /);
  const end = nextSection === -1 ? remaining.length : nextSection + 1;
  return body.slice(0, Math.max(0, idx)).trimEnd() + remaining.slice(end);
}

function _firstHeadingOrLine(summary: string, issueNumber: number): string {
  const heading = summary.split('\n').find((l) => l.startsWith('#'));
  if (heading) return heading.replace(/^#+\s*/, '').trim();
  const firstLine = summary.split('\n').find((l) => l.trim().length > 0);
  return firstLine?.trim() ?? `Resolve issue #${issueNumber}`;
}
