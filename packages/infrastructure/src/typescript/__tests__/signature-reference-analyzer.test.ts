import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DeclaredSignatureChange,
  SignatureReferenceAnalysis,
  SignatureReferenceAnalyzerPort,
} from '@ai-sdlc/application/ports';
import { createSignatureReferenceAnalyzer } from '../signature-reference-analyzer.js';

const tempRoots: string[] = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'sig-ref-analyzer-'));
  tempRoots.push(root);
  writePackageJson(root, 'test-root');
  return root;
}

function makeMinimalTsconfig(baseUrl: string, exclude: string[] = []): object {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      baseUrl,
      paths: {},
      strict: true,
    },
    exclude,
  };
}

function writePackageJson(dir: string, name: string, dependencies: Record<string, string> = {}) {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', type: 'module', dependencies }, null, 2),
  );
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function runAnalyzer(
  worktreeRoot: string,
  changes: DeclaredSignatureChange[],
): Promise<SignatureReferenceAnalysis[]> {
  const analyzer: SignatureReferenceAnalyzerPort = createSignatureReferenceAnalyzer();
  return analyzer.analyze({ worktreeRoot, changes });
}

describe('SignatureReferenceAnalyzer', () => {
  describe('finds direct aliased and re-exported references to an exported function', () => {
    it('resolves direct calls, imported aliases, and re-exports to the same declaration', async () => {
      const root = makeRoot();
      const srcDir = join(root, 'src');
      mkdirSync(srcDir, { recursive: true });

      writeFileSync(
        join(srcDir, 'index.ts'),
        `
export { doThing } from './utils.js';
export function main() {}
`,
      );
      writeFileSync(
        join(srcDir, 'utils.ts'),
        `
export function doThing() { return 42; }
export function helper() {}
`,
      );
      writeFileSync(
        join(srcDir, 'caller.ts'),
        `
import { doThing } from './index.js';
import { doThing as alias } from './index.js';
export function run() {
  doThing();
  alias();
}
`,
      );

      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(makeMinimalTsconfig('./src'), null, 2),
      );

      const results = await runAnalyzer(root, [
        { declarationFile: 'src/utils.ts', symbol: 'doThing' },
      ]);

      expect(results).toHaveLength(1);
      const result = results[0]!;
      expect(result.change).toEqual({ declarationFile: 'src/utils.ts', symbol: 'doThing' });
      expect(result.declaration).toBeDefined();
      expect(result.references.length).toBeGreaterThanOrEqual(1);
      expect(result.references.every((r) => r.kind === 'call' || r.kind === 'value')).toBe(true);
    });
  });

  describe('finds cross-package and tsconfig-excluded test callers', () => {
    it('discovers test files excluded by package tsconfig exclude patterns', async () => {
      const root = makeRoot();
      const pkgDir = join(root, 'packages', 'mylib');
      const srcDir = join(pkgDir, 'src');
      const testsDir = join(pkgDir, '__tests__');
      mkdirSync(srcDir, { recursive: true });
      mkdirSync(testsDir, { recursive: true });

      writePackageJson(pkgDir, '@test/mylib');
      writeFileSync(
        join(pkgDir, 'tsconfig.json'),
        JSON.stringify(
          {
            ...makeMinimalTsconfig('./src'),
            exclude: ['__tests__', 'node_modules'],
          },
          null,
          2,
        ),
      );

      writeFileSync(
        join(srcDir, 'index.ts'),
        `
export function compute(x: number) { return x * 2; }
`,
      );
      writeFileSync(
        join(testsDir, 'compute.test.ts'),
        `
import { compute } from '../src/index.js';
it('computes', () => { expect(compute(2)).toBe(4); });
`,
      );

      const results = await runAnalyzer(root, [
        { declarationFile: 'packages/mylib/src/index.ts', symbol: 'compute' },
      ]);

      expect(results).toHaveLength(1);
      const testRefs = results[0]!.references.filter(
        (r) => r.file.includes('__tests__') || r.file.includes('.test.'),
      );
      expect(testRefs.length).toBeGreaterThan(0);
    });

    it('finds references across package boundaries', async () => {
      const root = makeRoot();
      const pkgA = join(root, 'packages', 'pkg-a');
      const pkgB = join(root, 'packages', 'pkg-b');
      mkdirSync(join(pkgA, 'src'), { recursive: true });
      mkdirSync(join(pkgB, 'src'), { recursive: true });

      writePackageJson(pkgA, '@test/pkg-a');
      writePackageJson(pkgB, '@test/pkg-b', { '@test/pkg-a': 'workspace:*' });
      writeFileSync(
        join(pkgA, 'tsconfig.json'),
        JSON.stringify(makeMinimalTsconfig('./src'), null, 2),
      );
      writeFileSync(
        join(pkgB, 'tsconfig.json'),
        JSON.stringify(makeMinimalTsconfig('./src'), null, 2),
      );

      writeFileSync(
        join(pkgA, 'src', 'index.ts'),
        `
export function sharedFunc() { return 'shared'; }
`,
      );

      writeFileSync(
        join(pkgB, 'src', 'consumer.ts'),
        `
import { sharedFunc } from '@test/pkg-a';
export function useShared() { return sharedFunc(); }
`,
      );

      const results = await runAnalyzer(root, [
        { declarationFile: 'packages/pkg-a/src/index.ts', symbol: 'sharedFunc' },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0]!.references.some((r) => r.file.includes('packages/pkg-b'))).toBe(true);
    });
  });

  describe('qualified interface methods exclude unrelated same-named members', () => {
    it('does not collect heartbeat from WorkerLeasePort when querying AnotherInterface.heartbeat', async () => {
      const root = makeRoot();
      const srcDir = join(root, 'src');
      mkdirSync(srcDir, { recursive: true });

      writeFileSync(
        join(srcDir, 'interfaces.ts'),
        `
export interface WorkerLeasePort {
  heartbeat(): void;
}
export interface AnotherInterface {
  heartbeat(): string;
  tick(): number;
}
`,
      );

      writeFileSync(
        join(srcDir, 'consumer.ts'),
        `
import { AnotherInterface } from './interfaces.js';
export function process(impl: AnotherInterface) {
  return impl.heartbeat();
}
`,
      );

      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(makeMinimalTsconfig('./src'), null, 2),
      );

      const results = await runAnalyzer(root, [
        { declarationFile: 'src/interfaces.ts', symbol: 'AnotherInterface.heartbeat' },
      ]);

      expect(results).toHaveLength(1);
      const refs = results[0]!.references;
      const heartbeatRefs = refs.filter((r) => r.kind === 'call' && r.file.includes('consumer'));
      expect(heartbeatRefs.length).toBe(1);
    });
  });

  describe('declarations imports and export-only syntax are not impact references', () => {
    it('excludes the declaration site itself', async () => {
      const root = makeRoot();
      const srcDir = join(root, 'src');
      mkdirSync(srcDir, { recursive: true });

      writeFileSync(
        join(srcDir, 'lib.ts'),
        `
export function targetFunc() { return true; }
`,
      );
      writeFileSync(
        join(srcDir, 'index.ts'),
        `
export { targetFunc } from './lib.js';
`,
      );

      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(makeMinimalTsconfig('./src'), null, 2),
      );

      const results = await runAnalyzer(root, [
        { declarationFile: 'src/lib.ts', symbol: 'targetFunc' },
      ]);

      expect(results).toHaveLength(1);
      const refs = results[0]!.references;
      expect(refs.some((r) => r.file === 'src/lib.ts')).toBe(false);
    });

    it('does not count import statements as references', async () => {
      const root = makeRoot();
      const srcDir = join(root, 'src');
      mkdirSync(srcDir, { recursive: true });

      writeFileSync(
        join(srcDir, 'lib.ts'),
        `
export function myFunc() {}
`,
      );
      writeFileSync(
        join(srcDir, 'consumer.ts'),
        `
import { myFunc } from './lib.js';
`,
      );

      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(makeMinimalTsconfig('./src'), null, 2),
      );

      const results = await runAnalyzer(root, [
        { declarationFile: 'src/lib.ts', symbol: 'myFunc' },
      ]);

      expect(results).toHaveLength(1);
      const importRefs = results[0]!.references.filter(
        (r) => r.kind === 'value' && r.file.includes('consumer'),
      );
      expect(importRefs.length).toBe(0);
    });
  });

  describe('returns stable deduplicated repository-relative references', () => {
    it('deduplicates hits from multiple analysis runs and sorts deterministically', async () => {
      const root = makeRoot();
      const srcDir = join(root, 'src');
      mkdirSync(srcDir, { recursive: true });

      writeFileSync(
        join(srcDir, 'lib.ts'),
        `
export function sortMe() {}
`,
      );
      writeFileSync(
        join(srcDir, 'a.ts'),
        `
import { sortMe } from './lib.js';
import { sortMe as alias } from './lib.js';
const copy = sortMe;
export { copy, alias };
`,
      );

      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(makeMinimalTsconfig('./src'), null, 2),
      );

      const results = await runAnalyzer(root, [
        { declarationFile: 'src/lib.ts', symbol: 'sortMe' },
      ]);

      expect(results).toHaveLength(1);
      const refs = results[0]!.references;
      const files = refs.map((r) => r.file);
      const uniqueFiles = [...new Set(files)];
      expect(files.length).toBe(uniqueFiles.length);
    });

    it('returns repository-relative paths (not absolute)', async () => {
      const root = makeRoot();
      const srcDir = join(root, 'src');
      mkdirSync(srcDir, { recursive: true });

      writeFileSync(
        join(srcDir, 'lib.ts'),
        `
export function relPath() {}
`,
      );
      writeFileSync(
        join(srcDir, 'main.ts'),
        `
import { relPath } from './lib.js';
relPath();
`,
      );

      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(makeMinimalTsconfig('./src'), null, 2),
      );

      const results = await runAnalyzer(root, [
        { declarationFile: 'src/lib.ts', symbol: 'relPath' },
      ]);

      expect(results).toHaveLength(1);
      for (const ref of results[0]!.references) {
        expect(ref.file).not.toMatch(/^\/tmp/);
        expect(ref.file).not.toMatch(/^[A-Za-z]:/);
        expect(ref.file.startsWith(root)).toBe(false);
      }
    });
  });

  describe('unknown declarations fail closed with an actionable diagnostic', () => {
    it('returns unresolvedDiagnostic for a non-existent file', async () => {
      const root = makeRoot();
      const results = await runAnalyzer(root, [
        { declarationFile: 'nonexistent/file.ts', symbol: 'foo' },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0]!.unresolvedDiagnostic).toBeDefined();
      expect(results[0]!.references).toHaveLength(0);
    });

    it('returns unresolvedDiagnostic for an unresolved owner.member symbol', async () => {
      const root = makeRoot();
      const srcDir = join(root, 'src');
      mkdirSync(srcDir, { recursive: true });

      writeFileSync(
        join(srcDir, 'lib.ts'),
        `
export interface SomeType {
  existing(): void;
}
`,
      );
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(makeMinimalTsconfig('./src'), null, 2),
      );

      const results = await runAnalyzer(root, [
        { declarationFile: 'src/lib.ts', symbol: 'SomeType.nonexistent' },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0]!.unresolvedDiagnostic).toBeDefined();
    });
  });

  describe('dependency generated cache and outside-worktree files are excluded', () => {
    it('excludes node_modules from results', async () => {
      const root = makeRoot();
      const srcDir = join(root, 'src');
      const nodeModulesDir = join(root, 'node_modules', '@types', 'node');
      mkdirSync(srcDir, { recursive: true });
      mkdirSync(nodeModulesDir, { recursive: true });

      writeFileSync(
        join(srcDir, 'lib.ts'),
        `
export function libFunc() {}
`,
      );
      writeFileSync(
        join(nodeModulesDir, 'index.d.ts'),
        `
export function libFunc(): void;
`,
      );

      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(makeMinimalTsconfig('./src'), null, 2),
      );

      const results = await runAnalyzer(root, [
        { declarationFile: 'src/lib.ts', symbol: 'libFunc' },
      ]);

      expect(results).toHaveLength(1);
      const nodeModulesRefs = results[0]!.references.filter((r) => r.file.includes('node_modules'));
      expect(nodeModulesRefs).toHaveLength(0);
    });

    it('excludes build output directories', async () => {
      const root = makeRoot();
      const srcDir = join(root, 'src');
      const distDir = join(root, 'dist');
      mkdirSync(srcDir, { recursive: true });
      mkdirSync(distDir, { recursive: true });

      writeFileSync(
        join(srcDir, 'lib.ts'),
        `
export function buildExclude() {}
`,
      );
      writeFileSync(
        join(distDir, 'lib.js'),
        `
export function buildExclude() {}
`,
      );

      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(makeMinimalTsconfig('./src'), null, 2),
      );

      const results = await runAnalyzer(root, [
        { declarationFile: 'src/lib.ts', symbol: 'buildExclude' },
      ]);

      expect(results).toHaveLength(1);
      const distRefs = results[0]!.references.filter((r) => r.file.includes('dist'));
      expect(distRefs).toHaveLength(0);
    });

    it('excludes coverage directories', async () => {
      const root = makeRoot();
      const srcDir = join(root, 'src');
      const coverageDir = join(root, 'coverage', 'lcov-report');
      mkdirSync(srcDir, { recursive: true });
      mkdirSync(coverageDir, { recursive: true });

      writeFileSync(
        join(srcDir, 'lib.ts'),
        `
export function coverageExclude() {}
`,
      );
      writeFileSync(
        join(coverageDir, 'lib.ts.html'),
        `
<pre>export function coverageExclude() {}</pre>
`,
      );

      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(makeMinimalTsconfig('./src'), null, 2),
      );

      const results = await runAnalyzer(root, [
        { declarationFile: 'src/lib.ts', symbol: 'coverageExclude' },
      ]);

      expect(results).toHaveLength(1);
      const coverageRefs = results[0]!.references.filter((r) => r.file.includes('coverage'));
      expect(coverageRefs).toHaveLength(0);
    });

    it('excludes orchestration artifacts directory', async () => {
      const root = makeRoot();
      const srcDir = join(root, 'src');
      const orchDir = join(root, '.ai-orchestrator', 'artifacts');
      mkdirSync(srcDir, { recursive: true });
      mkdirSync(orchDir, { recursive: true });

      writeFileSync(
        join(srcDir, 'lib.ts'),
        `
export function orchExclude() {}
`,
      );
      writeFileSync(
        join(orchDir, 'lib.ts'),
        `
export function orchExclude() {}
`,
      );

      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(makeMinimalTsconfig('./src'), null, 2),
      );

      const results = await runAnalyzer(root, [
        { declarationFile: 'src/lib.ts', symbol: 'orchExclude' },
      ]);

      expect(results).toHaveLength(1);
      const orchRefs = results[0]!.references.filter((r) => r.file.includes('.ai-orchestrator'));
      expect(orchRefs).toHaveLength(0);
    });

    it('excludes files outside the worktree', async () => {
      const root = makeRoot();
      const srcDir = join(root, 'src');
      const outsideDir = mkdtempSync(join(tmpdir(), 'outside-worktree-'));
      tempRoots.push(outsideDir);
      mkdirSync(srcDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });

      writeFileSync(
        join(srcDir, 'lib.ts'),
        `
export function outsideExclude() {}
`,
      );
      writeFileSync(
        join(outsideDir, 'evil.ts'),
        `
import { outsideExclude } from '${root}/src/lib.js';
outsideExclude();
`,
      );

      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify(makeMinimalTsconfig('./src'), null, 2),
      );

      const results = await runAnalyzer(root, [
        { declarationFile: 'src/lib.ts', symbol: 'outsideExclude' },
      ]);

      expect(results).toHaveLength(1);
      const outsideRefs = results[0]!.references.filter((r) => r.file.startsWith(tmpdir()));
      expect(outsideRefs).toHaveLength(0);
    });
  });
});
