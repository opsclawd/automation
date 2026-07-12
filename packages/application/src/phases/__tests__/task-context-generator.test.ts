import { describe, it, expect } from 'vitest';
import { TaskContextGenerator } from '../task-context-generator.js';
import { TaskManifest, TaskManifestEntry } from '../results/schemas/task-manifest.js';

describe('TaskContextGenerator', () => {
  const generator = new TaskContextGenerator();

  const mockManifest: TaskManifest = {
    version: 2,
    task_count: 2,
    tasks: [
      {
        n: 1,
        title: 'Dependency Task',
        acceptance_criteria: ['Done'],
      } as TaskManifestEntry,
      {
        n: 2,
        title: 'Current Task',
        description: 'Do something',
        acceptance_criteria: ['Verify X'],
        design_sections: ['Data Model'],
        depends_on: [1],
        expected_files: ['src/index.ts'],
        relevant_symbols: ['MyClass'],
        validation_commands: ['npm test'],
        migration_constraints: ['No breaking changes'],
        out_of_scope: ['UI changes'],
        invariants: [
          {
            name: 'Invariant 1',
            description: 'Desc 1',
            test_case_name: 'test_inv_1',
          },
        ],
      } as TaskManifestEntry,
    ],
  };

  const planMd = `
## Task 1: Dependency Task
Dependency body.

## Task 2: Current Task
Current body.
`;

  const designMd = `
# Design

## Data Model
Definition of Data Model.

## Other Section
Something else.
`;

  const dependencyLogs = new Map<number, string>([
    [1, '# Implementation Log - Task 1\n\n## Implementation Detail\nImplemented the base class.'],
  ]);

  it('generates a full task context for V2 manifest', () => {
    const input = {
      task: mockManifest.tasks[1]!,
      manifest: mockManifest,
      planMd,
      designMd,
      dependencyLogs,
      workspaceConstraints: 'No networking.',
      cwd: '/app',
      repoId: 'owner/repo',
      branchName: 'ai/issue-1',
      startCommitSha: 'abc123',
    };

    const result = generator.generate(input);
    expect(result.content).toContain('# Task Context: Task 2');
    expect(result.content).toContain('Title: Current Task');
    expect(result.content).toContain('No networking.');
    expect(result.content).toContain('Current body.');
    expect(result.content).toContain('### Acceptance Criteria\n- Verify X');
    expect(result.content).toContain('### Data Model\n\nDefinition of Data Model.');
    expect(result.content).not.toContain('Other Section');
    expect(result.content).toContain('### Task 1 Summary\n\nImplemented the base class.');
    expect(result.content).toContain('### Expected Files\n- src/index.ts');
    expect(result.content).toContain('### Relevant Symbols\n- MyClass');
    expect(result.content).toContain('## Validation Commands\n\n```bash\nnpm test\n```');
    expect(result.content).toContain(
      '## Migration & Compatibility Constraints\n\n- No breaking changes',
    );
    expect(result.content).toContain('## Explicitly Out-of-Scope\n\n- UI changes');
    expect(result.content).toContain('## Behavioral Invariants');
    expect(result.content).toContain('- **Invariant 1**: Desc 1 (Test: `test_inv_1`)');
    expect(result.diagnostics.truncated).toHaveLength(0);
    expect(result.diagnostics.unresolvedReferences).toHaveLength(0);
  });

  it('handles missing references gracefully', () => {
    const input = {
      task: {
        n: 2,
        title: 'Current Task',
        design_sections: ['Non-existent'],
        depends_on: [3],
      } as TaskManifestEntry,
      manifest: mockManifest,
      planMd: '## Task 2: Current Task\nBody',
      workspaceConstraints: '',
      cwd: '/app',
      repoId: 'repo',
      branchName: 'branch',
    };

    const result = generator.generate(input);
    expect(result.diagnostics.unresolvedReferences).toContain('design_section:Non-existent');
    expect(result.diagnostics.unresolvedReferences).toContain('dependency_log:3');
  });

  it('respects the context budget', () => {
    const longBody = 'A'.repeat(40000);
    const input = {
      task: { n: 1, title: 'Big Task' } as TaskManifestEntry,
      manifest: { version: 2, task_count: 1, tasks: [] } as TaskManifest,
      planMd: `## Task 1: Big Task\n${longBody}`,
      workspaceConstraints: '',
      cwd: '/app',
      repoId: 'repo',
      branchName: 'branch',
    };

    const result = generator.generate(input);
    expect(result.content.length).toBeLessThanOrEqual(30500); // Allow some buffer for headers
    expect(result.diagnostics.truncated).toContain('context_overflow');
  });

  it('renders nothing for invariants when absent in V2 manifest', () => {
    const input = {
      task: {
        n: 1,
        title: 'No Invariants Task',
      } as TaskManifestEntry,
      manifest: { version: 2, task_count: 1, tasks: [] } as unknown as TaskManifest,
      planMd: '## Task 1: No Invariants Task\nBody',
      workspaceConstraints: '',
      cwd: '/app',
      repoId: 'repo',
      branchName: 'branch',
    };

    const result = generator.generate(input);
    expect(result.content).not.toContain('## Behavioral Invariants');
  });

  it('renders nothing for invariants in V1 manifest', () => {
    const input = {
      task: {
        n: 1,
        title: 'V1 Task',
      } as TaskManifestEntry,
      manifest: { version: 1, task_count: 1, tasks: [] } as unknown as TaskManifest,
      planMd: '## Task 1: V1 Task\nBody',
      workspaceConstraints: '',
      cwd: '/app',
      repoId: 'repo',
      branchName: 'branch',
    };

    const result = generator.generate(input);
    expect(result.content).not.toContain('## Behavioral Invariants');
  });
});
