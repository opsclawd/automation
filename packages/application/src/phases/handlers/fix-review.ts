import { PhaseName, AgentProfileName, type Failure, type FailureKind } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { runSingleShotAgentPhase } from './run-single-shot-agent-phase.js';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';
import { formatLedgerForFixPrompt, type FindingLedger } from '../../review-fix/finding-ledger.js';
import { invalidateValidationEvidence } from '../validation-evidence.js';
import {
  DELETED_SENTINEL,
  formatValidationCriticalFilesWarning,
  hashContent,
  parseStatusPaths,
  wasRevertedToBeforeState,
  type ValidationCriticalFile,
} from '../../review-fix/validation-critical-files.js';
import { parseGitStatusLine, unquoteGitPath } from '../../artifacts/orchestrator-artifacts.js';
import { formatSelfVerifyInstructions } from '../../prompts/constants.js';
import { isGovernanceFilePath } from '../../scratch-file-remediation.js';

export interface FixReviewHandlerOpts {
  profileName?: string;
  selfVerifyCommands?: string[] | undefined;
  governanceProtectedPaths?: string[] | undefined;
}

export class FixReviewHandler implements PhaseHandler {
  readonly phase = PhaseName('fix-review');

  constructor(private readonly opts: FixReviewHandlerOpts = {}) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('fix_review.started', 'info', 'starting targeted review-fix pass', {
      policy: ctx.executionPolicy,
    });

    // 1. Read finding ledger or code-review.md
    let formattedFindings = '';
    try {
      const ledgerRaw = await ctx.artifacts.read(ctx.runUuid, 'finding-ledger.json');
      const ledger = JSON.parse(ledgerRaw) as FindingLedger;
      formattedFindings = formatLedgerForFixPrompt(ledger);
    } catch {
      try {
        const reviewMd = await ctx.artifacts.read(ctx.runUuid, 'code-review.md');
        formattedFindings = reviewMd;
      } catch {
        formattedFindings = 'Fix all review findings reported in code-review.md.';
      }
    }

    // 2. Resolve fix profile
    const fixProfile =
      ctx.resolveProfile?.('fix-review') ??
      ctx.resolveProfile?.('implement') ??
      AgentProfileName(this.opts.profileName ?? 'opencode-frontier');

    // 3. Load targeted fix template
    let fixTemplate: string | undefined;
    if (ctx.promptsRoot) {
      try {
        fixTemplate = loadPromptTemplate('review-fix', 'targeted-fix', {
          promptsRoot: ctx.promptsRoot,
        });
      } catch {
        // Handled in runSingleShotAgentPhase
      }
    }

    // Read validation-critical files if recorded by fix-validate
    let criticalFiles: ValidationCriticalFile[] = [];
    try {
      const raw = await ctx.artifacts.read(ctx.runUuid, 'validate/critical-files.json');
      const parsed = JSON.parse(raw);
      criticalFiles = Array.isArray(parsed) ? parsed : [];
    } catch {
      criticalFiles = [];
    }
    const validationCriticalWarning = formatValidationCriticalFilesWarning(criticalFiles);
    const selfVerifyCommands = this.opts.selfVerifyCommands ?? ctx.selfVerifyCommands;

    let statusBefore = '';
    try {
      if (ctx.git) {
        statusBefore = await ctx.git.status(ctx.cwd);
      }
    } catch {
      statusBefore = '';
    }

    // 4. Run fixer agent invocation
    const fixRunResult = await runSingleShotAgentPhase(ctx, {
      phase: 'fix-review',
      profile: fixProfile,
      step: 'targeted-fix',
      ...(fixTemplate ? { template: fixTemplate } : {}),
      vars: {
        issue_number: String(ctx.issueNumber),
        cwd: ctx.cwd,
        review_findings: formattedFindings,
        validation_critical_files: validationCriticalWarning,
        SELF_VERIFY_INSTRUCTIONS: formatSelfVerifyInstructions(selfVerifyCommands),
      },
      agentContract: {
        requiredArtifacts: [],
        mustNotChangeBranch: true,
        mustNotCreateCommit: true,
      },
      resultJsonPath: 'fix-review-result.json',
      skipCompletedEmit: true,
    });

    if (fixRunResult.outcome !== 'passed') {
      emit('fix_review.failed', 'error', 'targeted fix agent failed');
      return fixRunResult;
    }

    // 5. Check result for cannot_fix verdict
    if (fixRunResult.result.result === 'cannot_fix') {
      const reason =
        'reason' in fixRunResult.result &&
        typeof fixRunResult.result.reason === 'string' &&
        fixRunResult.result.reason.trim()
          ? `: ${fixRunResult.result.reason.trim()}`
          : '';
      const message = `targeted fixer reported it cannot fix the review findings${reason}`;
      emit('fix_review.failed', 'error', message);
      return {
        outcome: 'needs_human_review',
        failure: {
          runUuid: ctx.runUuid,
          phase: this.phase,
          kind: 'needs_human_review',
          message,
          canRetry: true,
          suggestedAction: 'Review the findings and intervene manually.',
          artifacts: ['code-review.md', 'finding-ledger.json'],
          detectedAt: ctx.now(),
        },
      };
    }

    // 6. Check whether fixer modified any governance-sensitive files
    if (ctx.git) {
      let statusAfter = '';
      try {
        statusAfter = await ctx.git.status(ctx.cwd);
      } catch {
        statusAfter = '';
      }
      const pathsBefore = parseStatusPaths(statusBefore, ctx.cwd);
      const pathsAfter = parseStatusPaths(statusAfter, ctx.cwd);
      const customProtected = this.opts.governanceProtectedPaths ?? ctx.governanceProtectedPaths;

      const modifiedGovernanceFiles: string[] = [];
      for (const path of pathsAfter) {
        if (isGovernanceFilePath(path, customProtected)) {
          if (!pathsBefore.has(path)) {
            modifiedGovernanceFiles.push(path);
          } else {
            try {
              const currentContent = await ctx.git.worktreeFileContent(ctx.cwd, path);
              const headContent = await ctx.git
                .fileContent(ctx.cwd, 'HEAD', path)
                .catch(() => undefined);
              if (currentContent !== headContent) {
                modifiedGovernanceFiles.push(path);
              }
            } catch {
              modifiedGovernanceFiles.push(path);
            }
          }
        }
      }

      if (modifiedGovernanceFiles.length > 0) {
        const msg = `Governance-sensitive file(s) modified during review fix: ${modifiedGovernanceFiles.join(', ')}. Automated fixers must not edit compliance or license registries.`;
        emit('fix_review.governance_file_modified', 'error', msg, {
          paths: modifiedGovernanceFiles,
        });
        emit('fix_review.failed', 'error', msg);
        return {
          outcome: 'needs_human_review',
          failure: {
            runUuid: ctx.runUuid,
            phase: this.phase,
            kind: 'needs_human_review',
            message: msg,
            canRetry: false,
            suggestedAction:
              'Review the modified governance registry files and revert unauthorized compliance changes.',
            artifacts: ['code-review.md', 'finding-ledger.json'],
            detectedAt: ctx.now(),
          },
        };
      }
    }

    // 7. Check whether fixer reverted any validation-critical files
    if (criticalFiles.length > 0 && ctx.git) {
      for (const cf of criticalFiles) {
        let currentContent: string | undefined;
        let isNonEnoentReadFailure = false;
        let readFailureReason: string | undefined;
        try {
          currentContent = await ctx.git.worktreeFileContent(ctx.cwd, cf.path);
        } catch (err) {
          currentContent = undefined;
          isNonEnoentReadFailure = true;
          readFailureReason = err instanceof Error ? err.message : String(err);
        }

        if (currentContent === undefined && cf.beforeHash === DELETED_SENTINEL) {
          // Confirm actual absence before declaring a revert when beforeHash === DELETED_SENTINEL
          let confirmedAbsent = false;
          let nonEnoentError: string | undefined = readFailureReason;

          try {
            const statusOutput = await ctx.git.status(ctx.cwd);
            const lines = statusOutput.split(/\r?\n/).filter(Boolean);
            const matchingLine = lines.find((l) => {
              const paths = parseGitStatusLine(l.replace(/\r$/, ''));
              return paths.some((p) => unquoteGitPath(p) === cf.path);
            });
            if (matchingLine) {
              const statusXY = matchingLine.slice(0, 2);
              if (statusXY.includes('D')) {
                confirmedAbsent = true;
                nonEnoentError = undefined;
              } else {
                confirmedAbsent = false;
                nonEnoentError = `file is reported present in git status (${statusXY.trim()}) but could not be read`;
              }
            } else {
              // Not in git status. Check whether it exists in HEAD:
              try {
                await ctx.git.fileContent(ctx.cwd, 'HEAD', cf.path);
                // Exists in HEAD and git status is clean => file exists on disk matching HEAD!
                confirmedAbsent = false;
                nonEnoentError =
                  'file is present in HEAD and clean in worktree but could not be read';
              } catch {
                // Not in git status and not in HEAD => genuinely absent!
                confirmedAbsent = true;
                nonEnoentError = undefined;
              }
            }
          } catch {
            confirmedAbsent = !isNonEnoentReadFailure;
          }

          if (!confirmedAbsent) {
            emit(
              'review_fix.validation_critical_file_read_failed',
              'warn',
              `could not read validation-critical file "${cf.path}": ${nonEnoentError ?? 'non-ENOENT error'}`,
              {
                path: cf.path,
                diagnostic: cf.diagnostic,
                error: nonEnoentError,
              },
            );
            continue;
          }
        }

        const currentHash = hashContent(currentContent);
        if (wasRevertedToBeforeState({ currentHash, critical: cf })) {
          const revertMsg = `validation-critical file "${cf.path}" was reverted to pre-fix state: ${cf.diagnostic}`;
          emit('review_fix.validation_critical_file_reverted', 'error', revertMsg, {
            path: cf.path,
            diagnostic: cf.diagnostic,
          });
          const message = `Validation-critical file "${cf.path}" was reverted to pre-fix state where validation previously failed: ${cf.diagnostic}`;
          emit('fix_review.failed', 'error', message);
          return {
            outcome: 'needs_human_review',
            failure: {
              runUuid: ctx.runUuid,
              phase: this.phase,
              kind: 'needs_human_review',
              message,
              canRetry: true,
              suggestedAction:
                'Review the reverted validation-critical file and ensure validation fixes are preserved.',
              artifacts: ['code-review.md', 'finding-ledger.json', 'validate/critical-files.json'],
              detectedAt: ctx.now(),
            },
          };
        }
      }
    }

    await invalidateValidationEvidence(ctx, this.phase);

    emit('fix_review.completed', 'info', 'targeted review-fix pass completed', {
      policy: ctx.executionPolicy,
    });
    return { outcome: 'passed' };
  }

  private fail(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
    kind: FailureKind,
    message: string,
    suggestedAction?: string,
  ): PhaseResult {
    const failure: Failure = {
      runUuid: ctx.runUuid,
      phase: this.phase as string,
      kind,
      message,
      canRetry: true,
      suggestedAction: suggestedAction ?? 'Inspect fix logs and retry.',
      artifacts: [],
      detectedAt: ctx.now(),
    };
    emit('fix_review.failed', 'error', message);
    return { outcome: 'failed', failure };
  }
}
