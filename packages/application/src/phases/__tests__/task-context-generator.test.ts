import { describe, it, expect } from 'vitest';
import { TaskContextGenerator } from '../task-context-generator.js';
import {
  TaskManifest,
  TaskManifestEntry,
  TaskManifestEntryV2,
} from '../../results/schemas/task-manifest.js';

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
        reference_files: ['src/read-only.ts'],
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
    expect(result.content).toContain('### Expected Files (must modify and commit)\n- src/index.ts');
    expect(result.content).toContain('### Reference Files (read-only)\n- src/read-only.ts');
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

  it('renders mixed string and argv validation commands as JSON in validation fence', () => {
    const input = {
      task: {
        n: 1,
        title: 'Mixed Commands Task',
        validation_commands: [
          'pnpm lint',
          ['pnpm', 'exec', 'eslint', 'apps/app/app/position/[id].tsx'],
        ],
      } as unknown as TaskManifestEntry,
      manifest: {
        version: 2,
        task_count: 1,
        tasks: [],
      } as unknown as TaskManifest,
      planMd: '## Task 1: Mixed Commands Task\nBody',
      workspaceConstraints: '',
      cwd: '/app',
      repoId: 'repo',
      branchName: 'branch',
    };

    const result = generator.generate(input);
    expect(result.content).toContain(
      '## Validation Commands\n\n```bash\npnpm lint\n["pnpm","exec","eslint","apps/app/app/position/[id].tsx"]\n```',
    );
  });

  it('renders expected and reference files as distinct repository targets', () => {
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Use repository targets',
          expected_files: ['src/change.ts'],
          reference_files: ['src/read-only.ts'],
        },
      ],
    } as TaskManifest;
    const result = generator.generate({
      task: manifest.tasks[0]!,
      manifest,
      planMd: '## Task 1: Use repository targets\nBody',
      workspaceConstraints: '',
      cwd: '/app',
      repoId: 'repo',
      branchName: 'branch',
    });

    expect(result.content).toContain(
      '### Expected Files (must modify and commit)\n- src/change.ts',
    );
    expect(result.content).toContain('### Reference Files (read-only)\n- src/read-only.ts');
  });

  it('renders repository targets when only reference_files are declared', () => {
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Read a repository target',
          reference_files: ['src/read-only.ts'],
        },
      ],
    } as TaskManifest;
    const result = generator.generate({
      task: manifest.tasks[0]!,
      manifest,
      planMd: '## Task 1: Read a repository target\nBody',
      workspaceConstraints: '',
      cwd: '/app',
      repoId: 'repo',
      branchName: 'branch',
    });

    expect(result.content).toContain('## Repository Targets');
    expect(result.content).toContain('### Reference Files (read-only)\n- src/read-only.ts');
    expect(result.content).not.toContain('### Expected Files');
  });

  it('renders expected permitted may-extend non-goal and reference sections with must-versus-may language', () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'Full Scope Task',
          expected_files: ['src/deliverable.ts'],
          permitted_areas: ['src/components'],
          may_extend: ['src/integration.ts'],
          non_goals: ['src/legacy'],
          reference_files: ['src/types.ts'],
        } as TaskManifestEntry,
        {
          n: 2,
          title: 'Permission-Only Task',
          permitted_areas: ['src/tests'],
        } as TaskManifestEntry,
      ],
    };

    const result1 = generator.generate({
      task: manifest.tasks[0]!,
      manifest,
      planMd: '## Task 1: Full Scope Task\nBody 1',
      workspaceConstraints: '',
      cwd: '/app',
      repoId: 'repo',
      branchName: 'branch',
    });

    expect(result1.content).toContain('## Repository Targets');
    expect(result1.content).toContain(
      '### Expected Files (must modify and commit)\n- src/deliverable.ts',
    );
    expect(result1.content).toContain(
      '### Permitted Areas (may modify tracked files)\n- src/components',
    );
    expect(result1.content).toContain(
      '### May Extend (may modify exact files)\n- src/integration.ts',
    );
    expect(result1.content).toContain('### Non-Goals (must not modify)\n- src/legacy');
    expect(result1.content).toContain('### Reference Files (read-only)\n- src/types.ts');

    const result2 = generator.generate({
      task: manifest.tasks[1]!,
      manifest,
      planMd: '## Task 2: Permission-Only Task\nBody 2',
      workspaceConstraints: '',
      cwd: '/app',
      repoId: 'repo',
      branchName: 'branch',
    });

    expect(result2.content).toContain('## Repository Targets');
    expect(result2.content).toContain(
      '### Permitted Areas (may modify tracked files)\n- src/tests',
    );
    expect(result2.content).not.toContain('### Expected Files');
    expect(result2.content).not.toContain('### May Extend');
    expect(result2.content).not.toContain('### Non-Goals');
    expect(result2.content).not.toContain('### Reference Files');
  });

  it('task context renders authored V2 declarations without serializing derived areas', () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Authored Declarations Task',
          expected_files: ['packages/app/src/index.ts'],
        } as TaskManifestEntry,
      ],
    };

    const result = generator.generate({
      task: manifest.tasks[0]!,
      manifest,
      planMd: '## Task 1: Authored Declarations Task\nBody',
      workspaceConstraints: '',
      cwd: '/app',
      repoId: 'repo',
      branchName: 'branch',
    });

    expect(result.content).toContain(
      '### Expected Files (must modify and commit)\n- packages/app/src/index.ts',
    );
    expect(result.content).not.toContain('### Permitted Areas');
    expect(result.content).not.toContain('packages/app/src\n');
  });

  it('includes execution semantics when present in V2 manifest', () => {
    const generator = new TaskContextGenerator();
    const task: TaskManifestEntryV2 = {
      n: 1,
      title: 'Red task',
      task_type: 'red',
      paired_with_task: 2,
    };
    const manifest: TaskManifest = { version: 2, task_count: 1, tasks: [task] };
    const input = {
      task,
      manifest,
      planMd: '## Task 1\n\nTask body.',
      workspaceConstraints: 'No external changes.',
      cwd: '/fake/cwd',
      repoId: 'repo-1',
      branchName: 'main',
    };
    const result = generator.generate(input);
    expect(result.content).toContain('## Execution Semantics');
    expect(result.content).toContain('Task Type: red');
    expect(result.content).toContain('Paired With Task: 2');
    expect(result.content).toContain('CRITICAL GUIDANCE FOR RED TASKS');
    expect(result.content).toContain('it.fails()');
    expect(result.diagnostics.componentSizes['execution_semantics']).toBeGreaterThan(0);
  });

  it('includes RED task double inversion guidance when validation command is negated', () => {
    const generator = new TaskContextGenerator();
    const task: TaskManifestEntryV2 = {
      n: 1,
      title: 'Task with negated command',
      validation_commands: ['! pnpm test -- src/foo.test.ts'],
    };
    const manifest: TaskManifest = { version: 2, task_count: 1, tasks: [task] };
    const result = generator.generate({
      task,
      manifest,
      planMd: '## Task 1\n\nTask body.',
      workspaceConstraints: '',
      cwd: '/fake/cwd',
      repoId: 'repo-1',
      branchName: 'main',
    });
    expect(result.content).toContain('## Execution Semantics');
    expect(result.content).toContain('CRITICAL GUIDANCE FOR RED TASKS');
    expect(result.content).toContain('it.fails()');
  });

  it('renders only task_type or paired_with_task when only one is present', () => {
    const generator = new TaskContextGenerator();
    const taskOnlyType: TaskManifestEntryV2 = {
      n: 1,
      title: 'Type only task',
      task_type: 'implementation',
    };
    const res1 = generator.generate({
      task: taskOnlyType,
      manifest: { version: 2, task_count: 1, tasks: [taskOnlyType] },
      planMd: '## Task 1\n\nTask body.',
      workspaceConstraints: '',
      cwd: '/fake/cwd',
      repoId: 'repo-1',
      branchName: 'main',
    });
    expect(res1.content).toContain('## Execution Semantics');
    expect(res1.content).toContain('Task Type: implementation');
    expect(res1.content).not.toContain('Paired With Task');

    const taskOnlyPaired: TaskManifestEntryV2 = {
      n: 2,
      title: 'Paired only task',
      paired_with_task: 1,
    };
    const res2 = generator.generate({
      task: taskOnlyPaired,
      manifest: { version: 2, task_count: 1, tasks: [taskOnlyPaired] },
      planMd: '## Task 2\n\nTask body.',
      workspaceConstraints: '',
      cwd: '/fake/cwd',
      repoId: 'repo-1',
      branchName: 'main',
    });
    expect(res2.content).toContain('## Execution Semantics');
    expect(res2.content).not.toContain('Task Type');
    expect(res2.content).toContain('Paired With Task: 1');
  });

  it('renders nothing for execution semantics when absent in V2 manifest or in V1 manifest', () => {
    const generator = new TaskContextGenerator();
    const taskWithoutSemantics: TaskManifestEntryV2 = {
      n: 1,
      title: 'Standard task',
    };
    const resV2 = generator.generate({
      task: taskWithoutSemantics,
      manifest: { version: 2, task_count: 1, tasks: [taskWithoutSemantics] },
      planMd: '## Task 1\n\nTask body.',
      workspaceConstraints: '',
      cwd: '/fake/cwd',
      repoId: 'repo-1',
      branchName: 'main',
    });
    expect(resV2.content).not.toContain('## Execution Semantics');
    expect(resV2.diagnostics.componentSizes['execution_semantics']).toBeUndefined();

    const resV1 = generator.generate({
      task: {
        n: 1,
        title: 'V1 Task',
        task_type: 'red',
      } as unknown as TaskManifestEntry,
      manifest: { version: 1, task_count: 1, tasks: [] } as unknown as TaskManifest,
      planMd: '## Task 1\n\nTask body.',
      workspaceConstraints: '',
      cwd: '/fake/cwd',
      repoId: 'repo-1',
      branchName: 'main',
    });
    expect(resV1.content).not.toContain('## Execution Semantics');
    expect(resV1.diagnostics.componentSizes['execution_semantics']).toBeUndefined();
  });
});
