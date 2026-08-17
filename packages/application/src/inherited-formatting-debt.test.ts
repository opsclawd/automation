import { describe, it, expect } from 'vitest';
import {
  isFormattingOnlyChange,
  findInheritedFormattingDebtFiles,
  type FindInheritedFormattingDebtInput,
} from './inherited-formatting-debt.js';
import type { TaskManifest } from './results/schemas/task-manifest.js';
import type { GitPort } from './ports/git-port.js';

describe('inherited formatting debt', () => {
  describe('isFormattingOnlyChange', () => {
    it('treats formatter-only TypeScript and JavaScript changes as semantically equivalent', () => {
      const cases: Array<{ file: string; before: string; after: string }> = [
        {
          file: 'src/value.ts',
          before: "export const f=(value:string)=>({value,quote:'same'})\n",
          after: 'export const f = (value: string) => ({ value, quote: "same" });\n',
        },
        {
          file: 'src/module.mts',
          before: 'import { a } from "./a.js";\nconst x: number = 1;\nexport { x };',
          after: 'import { a } from "./a.js"\nconst x: number = 1\nexport { x }\n',
        },
        {
          file: 'src/common.cts',
          before: 'const x: { a: number; b: string } = { a: 1, b: "two" };',
          after: 'const x: {\n  a: number;\n  b: string;\n} = {\n  a: 1,\n  b: "two",\n};\n',
        },
        {
          file: 'src/script.js',
          before: 'const arr = [1, 2, 3];\nfunction fn(a) { return a * 2; }',
          after: 'const arr = [\n  1,\n  2,\n  3,\n];\nfunction fn(a) {\n  return a * 2;\n}\n',
        },
        {
          file: 'src/module.mjs',
          before: 'export const arrow = x => (x + 1);',
          after: 'export const arrow = (x) => x + 1;',
        },
        {
          file: 'src/common.cjs',
          before: 'module.exports = { value: ((1 + 2)) };',
          after: 'module.exports = { value: 1 + 2 };',
        },
        {
          file: 'src/component.tsx',
          before:
            'export const Button = ({ text }: { text: string }) => <button className="btn">{text}</button>;',
          after:
            "export const Button = ({ text }: { text: string }) => (\n  <button className='btn'>\n    {text}\n  </button>\n);",
        },
        {
          file: 'src/component.jsx',
          before: 'export const Box = () => <div id="box" />;',
          after: "export const Box = () => <div id='box'/>;\n",
        },
        {
          file: 'src/types.ts',
          before: 'type Foo = (string | number);',
          after: 'type Foo = string | number;',
        },
      ];

      for (const c of cases) {
        expect(isFormattingOnlyChange(c.file, c.before, c.after)).toBe(true);
      }
    });

    it('rejects parsed JSON object key reordering as semantically significant', () => {
      const before = JSON.stringify({
        alpha: 1,
        beta: { innerB: true, innerA: [1, 2, 'three'] },
        gamma: null,
      });

      const after = `{\n  "gamma": null,\n  "beta": {\n    "innerA": [\n      1,\n      2,\n      "three"\n    ],\n    "innerB": true\n  },\n  "alpha": 1\n}\n`;

      expect(isFormattingOnlyChange('package.json', before, after)).toBe(false);
      expect(
        isFormattingOnlyChange(
          'configs/settings.json',
          '{\n  "z": 1,\n  "a": 2\n}',
          '{"a":2,"z":1}',
        ),
      ).toBe(false);
    });

    it('accepts JSON formatting when object key order is preserved', () => {
      expect(
        isFormattingOnlyChange(
          'data.json',
          '{"a":1,"b":{"c":2}}',
          '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}\n',
        ),
      ).toBe(true);
    });

    it('rejects order-sensitive package exports key reordering', () => {
      expect(
        isFormattingOnlyChange(
          'package.json',
          '{"exports":{".":{"import":"./esm.js","default":"./cjs.js"}}}',
          '{"exports":{".":{"default":"./cjs.js","import":"./esm.js"}}}',
        ),
      ).toBe(false);
    });

    it('rejects semantic trivia, directives, and syntax discriminant changes', () => {
      const nonEquivalentCases: Array<{ file: string; before: string; after: string }> = [
        {
          file: 'src/check.ts',
          before: 'const x = 1;\n',
          after: '// @ts-nocheck\nconst x = 1;\n',
        },
        {
          file: 'src/cli.js',
          before: 'const x = 1;\n',
          after: '#!/usr/bin/env node\nconst x = 1;\n',
        },
        {
          file: 'src/class.ts',
          before: 'class A extends B {}\n',
          after: 'class A implements B {}\n',
        },
        {
          file: 'src/directive.js',
          before: '"use strict";\nconst x = 1;\n',
          after: '("use strict");\nconst x = 1;\n',
        },
      ];

      for (const c of nonEquivalentCases) {
        expect(isFormattingOnlyChange(c.file, c.before, c.after)).toBe(false);
      }
    });

    it('rejects semantic TypeScript tokens, directive escapes, and relocated diagnostic comments', () => {
      const nonEquivalentCases: Array<{ file: string; before: string; after: string }> = [
        {
          file: 'src/type-operator.ts',
          before: 'type T = keyof X[];\n',
          after: 'type T = readonly X[];\n',
        },
        {
          file: 'src/import-attributes.ts',
          before: 'import data from "./data.json" with { type: "json" };\n',
          after: 'import data from "./data.json" assert { type: "json" };\n',
        },
        {
          file: 'src/directive-escape.js',
          before: '"use strict";\nconst value = 1;\n',
          after: '"use\\x20strict";\nconst value = 1;\n',
        },
        {
          file: 'src/diagnostic-comment.ts',
          before: '// @ts-ignore\nconst first = 1;\nconst second = 2;\n',
          after: 'const first = 1;\n// @ts-ignore\nconst second = 2;\n',
        },
      ];

      for (const c of nonEquivalentCases) {
        expect(isFormattingOnlyChange(c.file, c.before, c.after)).toBe(false);
      }
    });

    it('accepts block-comment line-ending normalization as formatting-only', () => {
      expect(
        isFormattingOnlyChange(
          'src/comments.ts',
          '/* first line\r\n * second line */\r\nconst value=1;\r\n',
          '/* first line\n * second line */\nconst value = 1;\n',
        ),
      ).toBe(true);
    });

    it('rejects TypeScript identifier literal operator and control-flow changes', () => {
      const nonEquivalentCases: Array<{ file: string; before: string; after: string }> = [
        {
          file: 'src/value.ts',
          before: 'const n = left + 1',
          after: 'const n = right - 2',
        },
        {
          file: 'src/identifiers.ts',
          before: 'const oldName = 1;',
          after: 'const newName = 1;',
        },
        {
          file: 'src/literals.ts',
          before: 'const str = "hello"; const num = 42; const reg = /foo/g; const tmpl = `a ${1}`;',
          after: 'const str = "world"; const num = 43; const reg = /bar/g; const tmpl = `b ${1}`;',
        },
        {
          file: 'src/numeric-base.ts',
          before: 'const num = 1;',
          after: 'const num = 0x1;',
        },
        {
          file: 'src/numeric-format.ts',
          before: 'const num = 1;',
          after: 'const num = 1.0;',
        },
        {
          file: 'src/numeric-separator.ts',
          before: 'const num = 1000;',
          after: 'const num = 1_000;',
        },
        {
          file: 'src/bigint-base.ts',
          before: 'const big = 10n;',
          after: 'const big = 0xAn;',
        },
        {
          file: 'src/operators.ts',
          before: 'const positive = +x; const equals = a === b;',
          after: 'const positive = !x; const equals = a !== b;',
        },
        {
          file: 'src/calls.ts',
          before: 'doSomething(arg1, arg2);',
          after: 'doSomething(arg1, arg3);',
        },
        {
          file: 'src/control-flow.ts',
          before: 'if (condition) { doA(); }',
          after: 'if (condition) { doB(); }',
        },
        {
          file: 'src/loops.ts',
          before: 'if (condition) { doA(); }',
          after: 'while (condition) { doA(); }',
        },
        {
          file: 'src/precedence.ts',
          before: '(a + b) * c;',
          after: 'a + b * c;',
        },
        {
          file: 'src/declaration-flags.ts',
          before: 'let x = 1;',
          after: 'const x = 1;',
        },
        {
          file: 'src/declaration-flags.ts',
          before: 'var x = 1;',
          after: 'let x = 1;',
        },
        {
          file: 'src/import-type-only.ts',
          before: 'import { x } from "./a.js";',
          after: 'import type { x } from "./a.js";',
        },
        {
          file: 'src/import-specifier-type-only.ts',
          before: 'import { type x } from "./a.js";',
          after: 'import { x } from "./a.js";',
        },
        {
          file: 'src/export-type-only.ts',
          before: 'export { x } from "./a.js";',
          after: 'export type { x } from "./a.js";',
        },
        {
          file: 'src/export-specifier-type-only.ts',
          before: 'export { type x } from "./a.js";',
          after: 'export { x } from "./a.js";',
        },
        {
          file: 'src/export-assignment.ts',
          before: 'export default x;',
          after: 'export = x;',
        },
        {
          file: 'src/import-typeof.ts',
          before: 'type T = import("./a.js");',
          after: 'type T = typeof import("./a.js");',
        },
      ];

      for (const c of nonEquivalentCases) {
        expect(isFormattingOnlyChange(c.file, c.before, c.after)).toBe(false);
      }
    });

    it('rejects JSON value and array-order changes', () => {
      expect(isFormattingOnlyChange('data.json', '[1, 2, 3]', '[1, 3, 2]')).toBe(false);
      expect(isFormattingOnlyChange('data.json', '{"a": 1}', '{"a": 2}')).toBe(false);
      expect(isFormattingOnlyChange('data.json', '{"a": [1, 2]}', '{"a": [2, 1]}')).toBe(false);
      expect(isFormattingOnlyChange('data.json', '{"a": 1}', '{"a": 1, "b": 2}')).toBe(false);
      expect(isFormattingOnlyChange('data.json', '{"a": 1, "b": 2}', '{"a": 1}')).toBe(false);
    });

    it('rejects JSON member order, lossless numeric, negative-zero, and duplicate-member changes', () => {
      expect(isFormattingOnlyChange('data.json', '{"2":"b","1":"a"}', '{"1":"a","2":"b"}')).toBe(
        false,
      );
      expect(
        isFormattingOnlyChange(
          'data.json',
          '{"value":9007199254740992}',
          '{"value":9007199254740993}',
        ),
      ).toBe(false);
      expect(isFormattingOnlyChange('data.json', '{"value":0}', '{"value":-0}')).toBe(false);
      expect(isFormattingOnlyChange('data.json', '{"value":1}', '{"value":1,"value":1}')).toBe(
        false,
      );
      expect(isFormattingOnlyChange('data.json', '{"value":1}', '{"value":1.0}')).toBe(false);
      expect(isFormattingOnlyChange('data.json', '{"value":100}', '{"value":1e2}')).toBe(false);
    });

    it('fails closed for unsupported extensions parser diagnostics missing blobs and read errors', () => {
      // Unsupported extensions
      expect(isFormattingOnlyChange('README.md', '# Hello', '# Hello\n')).toBe(false);
      expect(isFormattingOnlyChange('config.yaml', 'key: value', 'key:  value')).toBe(false);
      expect(isFormattingOnlyChange('config.yml', 'a: 1', 'a: 1\n')).toBe(false);
      expect(isFormattingOnlyChange('script.sh', 'echo "hi"', 'echo "hi"\n')).toBe(false);
      expect(isFormattingOnlyChange('script.py', 'x = 1', 'x = 1\n')).toBe(false);

      // Parser diagnostics
      expect(isFormattingOnlyChange('bad.ts', 'const x = ;', 'const x = ;')).toBe(false);
      expect(isFormattingOnlyChange('bad.json', '{ invalid json }', '{ invalid json }')).toBe(
        false,
      );
    });
  });

  describe('findInheritedFormattingDebtFiles', () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 3,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['src/task1.ts', 'src/shared.json'],
        },
        {
          n: 2,
          title: 'Task 2',
          expected_files: ['src/task2.ts'],
        },
        {
          n: 3,
          title: 'Task 3',
          expected_files: ['src/task3.ts'],
        },
      ],
    };

    it('returns only candidates owned by an earlier completed task', async () => {
      const gitFiles: Record<string, string> = {
        'head-pre:src/task1.ts': 'export const a=1;\n',
        'head-post:src/task1.ts': 'export const a = 1;\n',
        'head-pre:src/task2.ts': 'export const b=2;\n',
        'head-post:src/task2.ts': 'export const b = 2;\n',
        'head-pre:src/task3.ts': 'export const c=3;\n',
        'head-post:src/task3.ts': 'export const c = 3;\n',
        'head-pre:src/unowned.ts': 'export const u=0;\n',
        'head-post:src/unowned.ts': 'export const u = 0;\n',
      };

      const git: Pick<GitPort, 'fileContent'> = {
        fileContent: async (_cwd, ref, path) => {
          const key = `${ref}:${path}`;
          if (key in gitFiles) return gitFiles[key]!;
          throw new Error(`File not found: ${key}`);
        },
      };

      const input: FindInheritedFormattingDebtInput = {
        cwd: '/worktree',
        manifest,
        currentTaskNumber: 2,
        completedTaskNumbers: new Set([1]),
        candidateFiles: ['src/task1.ts', 'src/task3.ts', 'src/unowned.ts'],
        preStepHead: 'head-pre',
        postStepHead: 'head-post',
        git,
      };

      const result = await findInheritedFormattingDebtFiles(input);
      expect(result).toEqual(['src/task1.ts']);
    });

    it('never classifies protected paths as inherited formatting debt', async () => {
      const protectedManifest: TaskManifest = {
        version: 2,
        task_count: 2,
        tasks: [
          {
            n: 1,
            title: 'Task 1',
            expected_files: [
              '.gitignore',
              '.ai-orchestrator.json',
              '.github/workflows/ci.yml',
              'src/a.ts',
            ],
          },
          {
            n: 2,
            title: 'Task 2',
            expected_files: ['src/b.ts'],
          },
        ],
      };

      const git: Pick<GitPort, 'fileContent'> = {
        fileContent: async () => '{\n  "formatted": true\n}\n',
      };

      const input: FindInheritedFormattingDebtInput = {
        cwd: '/worktree',
        manifest: protectedManifest,
        currentTaskNumber: 2,
        completedTaskNumbers: new Set([1]),
        candidateFiles: ['.gitignore', '.ai-orchestrator.json', '.github/workflows/ci.yml'],
        preStepHead: 'head-pre',
        postStepHead: 'head-post',
        git,
      };

      const result = await findInheritedFormattingDebtFiles(input);
      expect(result).toEqual([]);
    });

    it('fails closed for unsupported extensions parser diagnostics missing blobs and read errors', async () => {
      const git: Pick<GitPort, 'fileContent'> = {
        fileContent: async (_cwd, ref, path) => {
          if (path === 'src/read-error.ts') {
            throw new Error('git read error');
          }
          if (path === 'src/missing-post.ts' && ref === 'head-post') {
            throw new Error('fatal: path not in post commit');
          }
          if (path === 'src/syntax-err.ts') {
            return 'const x = ;';
          }
          return 'export const ok = 1;';
        },
      };

      const customManifest: TaskManifest = {
        version: 2,
        task_count: 2,
        tasks: [
          {
            n: 1,
            title: 'Task 1',
            expected_files: [
              'src/read-error.ts',
              'src/missing-post.ts',
              'src/syntax-err.ts',
              'README.md',
            ],
          },
          {
            n: 2,
            title: 'Task 2',
            expected_files: ['src/task2.ts'],
          },
        ],
      };

      const input: FindInheritedFormattingDebtInput = {
        cwd: '/worktree',
        manifest: customManifest,
        currentTaskNumber: 2,
        completedTaskNumbers: new Set([1]),
        candidateFiles: [
          'src/read-error.ts',
          'src/missing-post.ts',
          'src/syntax-err.ts',
          'README.md',
        ],
        preStepHead: 'head-pre',
        postStepHead: 'head-post',
        git,
      };

      const result = await findInheritedFormattingDebtFiles(input);
      expect(result).toEqual([]);
    });
  });
});
