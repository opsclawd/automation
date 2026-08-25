import type {
  TaskManifest,
  TaskManifestEntry,
  TaskManifestEntryV2,
} from '../results/schemas/task-manifest.js';
import { extractTaskBody } from './plan-tasks.js';

export interface TaskContextGeneratorInput {
  task: TaskManifestEntry;
  manifest: TaskManifest;
  planMd: string;
  designMd?: string;
  dependencyLogs?: Map<number, string>; // task number -> implementation-log.md content
  workspaceConstraints: string;
  cwd: string;
  repoId: string;
  branchName: string;
  startCommitSha?: string;
}

export interface TaskContextResult {
  content: string;
  diagnostics: {
    componentSizes: Record<string, number>;
    truncated: string[];
    unresolvedReferences: string[];
  };
}

const DEFAULT_BUDGET = 30000; // Total character budget for task-context.md

export class TaskContextGenerator {
  generate(input: TaskContextGeneratorInput): TaskContextResult {
    const {
      task,
      planMd,
      designMd,
      dependencyLogs = new Map<number, string>(),
      workspaceConstraints,
      cwd,
      repoId,
      branchName,
      startCommitSha,
    } = input;
    const diagnostics: TaskContextResult['diagnostics'] = {
      componentSizes: {},
      truncated: [],
      unresolvedReferences: [],
    };

    const sections: string[] = [];

    // 1. Task Header
    const header = `# Task Context: Task ${task.n}\n\nTitle: ${task.title}\n`;
    sections.push(header);
    diagnostics.componentSizes['header'] = header.length;

    // 1.5 Execution Semantics
    if (input.manifest.version === 2) {
      const t2 = task as TaskManifestEntryV2;
      const hasInvertedCommand = t2.validation_commands?.some((cmd) =>
        Array.isArray(cmd)
          ? cmd[0]?.trim().startsWith('!')
          : String(cmd).trim().startsWith('!'),
      );
      if (t2.task_type || t2.paired_with_task || hasInvertedCommand) {
        let execContent = '## Execution Semantics\n\n';
        if (t2.task_type) execContent += `Task Type: ${t2.task_type}\n`;
        if (t2.paired_with_task) execContent += `Paired With Task: ${t2.paired_with_task}\n`;
        if (t2.task_type === 'red' || hasInvertedCommand) {
          execContent +=
            '\nCRITICAL GUIDANCE FOR RED TASKS: Do NOT use test-runner-level inversion helpers (such as Vitest\'s `it.fails()` or `test.fails()`, or equivalent test runner inversion primitives) in test files for this task. The task\'s validation command already applies command-level `!` inversion (expecting a non-zero exit code). Combining runner-level inversion helpers like `it.fails()` with `!` command-level inversion causes the test runner to report exit code 0 when the test fails, which inverts the `!` validation wrapper into a validation failure. Write tests using standard direct assertions (e.g., `it(...)` or `test(...)`) of the expected correct behavior so that the test body throws and exits non-zero naturally.\n';
        }
        execContent += '\n';
        sections.push(execContent);
        diagnostics.componentSizes['execution_semantics'] = execContent.length;
      }
    }

    // 2. Workspace & Scope Constraints
    const constraints = `## Workspace & Scope Constraints\n\n${workspaceConstraints}\n\nWorking Directory: ${cwd}\nRepository: ${repoId}\nBranch: ${branchName}\n${startCommitSha ? `Start Commit: ${startCommitSha}\n` : ''}\n`;
    sections.push(constraints);
    diagnostics.componentSizes['constraints'] = constraints.length;

    // 3. Exact Task Requirements (High Priority)
    const bodyResult = extractTaskBody(planMd, { taskNumber: task.n, title: task.title });
    const taskBody = bodyResult.ok
      ? bodyResult.body.trim()
      : `(Failed to extract task body from plan.md: ${bodyResult.reason})`;
    if (!bodyResult.ok) diagnostics.unresolvedReferences.push('plan_task_body');

    let requirementSection = `## Task Requirements\n\n${taskBody}\n\n`;
    if (input.manifest.version === 2) {
      const t2 = task as TaskManifestEntryV2;
      if (t2.acceptance_criteria && t2.acceptance_criteria.length > 0) {
        requirementSection += `### Acceptance Criteria\n${t2.acceptance_criteria.map((ac) => `- ${ac}`).join('\n')}\n\n`;
      }
    }
    sections.push(requirementSection);
    diagnostics.componentSizes['requirements'] = requirementSection.length;

    // 4. Relevant Design Sections
    if (input.manifest.version === 2) {
      const t2 = task as TaskManifestEntryV2;
      if (t2.design_sections && t2.design_sections.length > 0) {
        let designContent = '## Relevant Design Decisions\n\n';
        if (designMd) {
          for (const sectionTitle of t2.design_sections) {
            const extracted = this.extractDesignSection(designMd, sectionTitle);
            if (extracted) {
              designContent += `### ${sectionTitle}\n\n${extracted}\n\n`;
            } else {
              diagnostics.unresolvedReferences.push(`design_section:${sectionTitle}`);
            }
          }
        } else {
          for (const sectionTitle of t2.design_sections) {
            diagnostics.unresolvedReferences.push(`design_section:${sectionTitle}`);
          }
        }
        if (designContent !== '## Relevant Design Decisions\n\n') {
          sections.push(designContent);
          diagnostics.componentSizes['design'] = designContent.length;
        }
      }
    }

    // 5. Dependency Summaries
    if (input.manifest.version === 2) {
      const t2 = task as TaskManifestEntryV2;
      if (t2.depends_on && t2.depends_on.length > 0) {
        let depContent = '## Completed Dependencies\n\n';
        for (const depId of t2.depends_on) {
          const log = dependencyLogs.get(depId);
          if (log) {
            const summary = this.summarizeLog(log);
            depContent += `### Task ${depId} Summary\n\n${summary}\n\n`;
          } else {
            diagnostics.unresolvedReferences.push(`dependency_log:${depId}`);
          }
        }
        sections.push(depContent);
        diagnostics.componentSizes['dependencies'] = depContent.length;
      }
    }

    // 6. Repository Targets (Files & Symbols)
    if (input.manifest.version === 2) {
      const t2 = task as TaskManifestEntryV2;
      const expectedFiles =
        t2.expected_files && t2.expected_files.length > 0
          ? t2.expected_files
          : t2.files && t2.files.length > 0
            ? t2.files
            : undefined;

      const hasExpectedFiles = Boolean(expectedFiles && expectedFiles.length > 0);
      const hasPermittedAreas = Boolean(t2.permitted_areas && t2.permitted_areas.length > 0);
      const hasMayExtend = Boolean(t2.may_extend && t2.may_extend.length > 0);
      const hasNonGoals = Boolean(t2.non_goals && t2.non_goals.length > 0);
      const hasReferenceFiles = Boolean(t2.reference_files && t2.reference_files.length > 0);
      const hasRelevantSymbols = Boolean(t2.relevant_symbols && t2.relevant_symbols.length > 0);

      if (
        hasExpectedFiles ||
        hasPermittedAreas ||
        hasMayExtend ||
        hasNonGoals ||
        hasReferenceFiles ||
        hasRelevantSymbols
      ) {
        let targetContent = '## Repository Targets\n\n';
        if (hasExpectedFiles && expectedFiles) {
          targetContent += `### Expected Files (must modify and commit)\n${expectedFiles.map((f) => `- ${f}`).join('\n')}\n\n`;
        }
        if (hasPermittedAreas && t2.permitted_areas) {
          targetContent += `### Permitted Areas (may modify tracked files)\n${t2.permitted_areas.map((f) => `- ${f}`).join('\n')}\n\n`;
        }
        if (hasMayExtend && t2.may_extend) {
          targetContent += `### May Extend (may modify exact files)\n${t2.may_extend.map((f) => `- ${f}`).join('\n')}\n\n`;
        }
        if (hasNonGoals && t2.non_goals) {
          targetContent += `### Non-Goals (must not modify)\n${t2.non_goals.map((f) => `- ${f}`).join('\n')}\n\n`;
        }
        if (hasReferenceFiles && t2.reference_files) {
          targetContent += `### Reference Files (read-only)\n${t2.reference_files.map((f) => `- ${f}`).join('\n')}\n\n`;
        }
        if (hasRelevantSymbols && t2.relevant_symbols) {
          targetContent += `### Relevant Symbols\n${t2.relevant_symbols.map((s) => `- ${s}`).join('\n')}\n\n`;
        }
        sections.push(targetContent);
        diagnostics.componentSizes['targets'] = targetContent.length;
      }
    }

    // 7. Deterministic Validation Commands
    if (input.manifest.version === 2) {
      const t2 = task as TaskManifestEntryV2;
      if (t2.validation_commands && t2.validation_commands.length > 0) {
        const rendered = t2.validation_commands.map((command) =>
          Array.isArray(command) ? JSON.stringify(command) : command,
        );
        const valContent = `## Validation Commands\n\n\`\`\`bash\n${rendered.join('\n')}\n\`\`\`\n\n`;
        sections.push(valContent);
        diagnostics.componentSizes['validation'] = valContent.length;
      }
    }

    // 8. Migration & Compatibility Constraints
    if (input.manifest.version === 2) {
      const t2 = task as TaskManifestEntryV2;
      if (t2.migration_constraints && t2.migration_constraints.length > 0) {
        const migContent = `## Migration & Compatibility Constraints\n\n${t2.migration_constraints.map((mc) => `- ${mc}`).join('\n')}\n\n`;
        sections.push(migContent);
        diagnostics.componentSizes['migration'] = migContent.length;
      }
    }

    // 9. Out-of-Scope Notes
    if (input.manifest.version === 2) {
      const t2 = task as TaskManifestEntryV2;
      if (t2.out_of_scope && t2.out_of_scope.length > 0) {
        const oosContent = `## Explicitly Out-of-Scope\n\n${t2.out_of_scope.map((oos) => `- ${oos}`).join('\n')}\n\n`;
        sections.push(oosContent);
        diagnostics.componentSizes['out_of_scope'] = oosContent.length;
      }
    }

    // 10. Behavioral Invariants
    if (input.manifest.version === 2) {
      const t2 = task as TaskManifestEntryV2;
      if (t2.invariants && t2.invariants.length > 0) {
        const invContent = `## Behavioral Invariants\n\nYou MUST implement the following behavioral invariants as named tests first (TDD):\n\n${t2.invariants.map((inv) => `- **${inv.name}**: ${inv.description} (Test: \`${inv.test_case_name}\`)`).join('\n')}\n\n`;
        sections.push(invContent);
        diagnostics.componentSizes['invariants'] = invContent.length;
      }
    }

    // Apply Budgeting (Simple truncation for now, prioritizing earlier sections)
    let totalSize = 0;
    const finalSections: string[] = [];
    for (const section of sections) {
      if (totalSize + section.length > DEFAULT_BUDGET) {
        const remaining = DEFAULT_BUDGET - totalSize;
        if (remaining > 100) {
          finalSections.push(
            section.slice(0, remaining) + '\n\n... (truncated due to budget) ...\n',
          );
          diagnostics.truncated.push('context_overflow');
        } else {
          diagnostics.truncated.push('context_overflow');
        }
        break;
      }
      finalSections.push(section);
      totalSize += section.length;
    }

    return {
      content: finalSections.join(''),
      diagnostics,
    };
  }

  private extractDesignSection(designMd: string, title: string): string | null {
    const lines = designMd.split(/\r?\n/);
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const headingRegex = new RegExp(`^#{1,4}\\s+.*${escapedTitle}.*`, 'i');

    let startLine = -1;
    let headingLevel = -1;

    for (let i = 0; i < lines.length; i++) {
      const match = headingRegex.exec(lines[i]!);
      if (match) {
        startLine = i;
        const levelMatch = /^#+/.exec(lines[i]!);
        headingLevel = levelMatch ? levelMatch[0].length : 1;
        break;
      }
    }

    if (startLine === -1) return null;

    const resultLines: string[] = [];
    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i]!;
      const levelMatch = /^#+/.exec(line);
      if (levelMatch && levelMatch[0].length <= headingLevel) {
        break;
      }
      resultLines.push(line);
    }

    return resultLines.join('\n').trim();
  }

  private summarizeLog(log: string): string {
    // Basic summarizer: try to find "Implementation Detail" or just return the first 1000 characters
    const lines = log.split(/\r?\n/);
    const detailHeaderIdx = lines.findIndex((l) => /^#{1,3}\s+Implementation Detail/i.test(l));
    if (detailHeaderIdx !== -1) {
      const summaryLines: string[] = [];
      for (let i = detailHeaderIdx + 1; i < lines.length; i++) {
        if (/^#{1,3}\s+/.test(lines[i]!)) break;
        summaryLines.push(lines[i]!);
      }
      const summary = summaryLines.join('\n').trim();
      if (summary.length > 0) return summary;
    }

    return log.slice(0, 2000).trim() + (log.length > 2000 ? '\n... (truncated) ...' : '');
  }
}
