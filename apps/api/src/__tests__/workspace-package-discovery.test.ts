import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  discoverWorkspacePackages,
  discoverWorkspacePackagesSync,
  type WorkspacePackageDiscoveryResult,
} from '../workspace-package-discovery.js';

const discoveryImplementations = [
  {
    name: 'async (discoverWorkspacePackages)',
    discover: async (root: string): Promise<WorkspacePackageDiscoveryResult> =>
      discoverWorkspacePackages(root),
  },
  {
    name: 'sync (discoverWorkspacePackagesSync)',
    discover: async (root: string): Promise<WorkspacePackageDiscoveryResult> =>
      discoverWorkspacePackagesSync(root),
  },
];

describe.each(discoveryImplementations)('Workspace Package Discovery ($name)', ({ discover }) => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-discovery-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('discovers package directories dependencies scripts and Bats availability', async () => {
    // 1. Setup pnpm-workspace.yaml
    const workspaceYaml = `packages:
  - 'packages/*'
  - 'apps/*'
`;
    await fs.writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), workspaceYaml, 'utf-8');

    // 2. Setup packages/shared
    const sharedDir = path.join(tmpDir, 'packages', 'shared');
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(
      path.join(sharedDir, 'package.json'),
      JSON.stringify({
        name: '@ai-sdlc/shared',
        scripts: { build: 'tsc', test: 'vitest' },
      }),
      'utf-8',
    );

    // 3. Setup packages/domain with dependency on shared
    const domainDir = path.join(tmpDir, 'packages', 'domain');
    await fs.mkdir(domainDir, { recursive: true });
    await fs.writeFile(
      path.join(domainDir, 'package.json'),
      JSON.stringify({
        name: '@ai-sdlc/domain',
        scripts: { build: 'tsc' },
        dependencies: {
          '@ai-sdlc/shared': 'workspace:*',
        },
      }),
      'utf-8',
    );

    // 4. Setup packages/infrastructure with devDep on shared, dep on domain
    const infraDir = path.join(tmpDir, 'packages', 'infrastructure');
    await fs.mkdir(infraDir, { recursive: true });
    await fs.writeFile(
      path.join(infraDir, 'package.json'),
      JSON.stringify({
        name: '@ai-sdlc/infrastructure',
        scripts: { build: 'tsc', test: 'vitest run' },
        dependencies: {
          '@ai-sdlc/domain': 'workspace:^1.0.0',
        },
        devDependencies: {
          '@ai-sdlc/shared': 'workspace:~',
        },
      }),
      'utf-8',
    );

    // 5. Setup apps/cli with peerDep on infrastructure, optionalDep on shared, and a .bats file
    const cliDir = path.join(tmpDir, 'apps', 'cli');
    const cliScriptsDir = path.join(cliDir, 'scripts', 'lib', '__tests__');
    await fs.mkdir(cliScriptsDir, { recursive: true });
    await fs.writeFile(
      path.join(cliDir, 'package.json'),
      JSON.stringify({
        name: '@ai-sdlc/cli',
        scripts: { 'test:bash': 'bats test.bats' },
        peerDependencies: {
          '@ai-sdlc/infrastructure': 'workspace:*',
        },
        optionalDependencies: {
          '@ai-sdlc/shared': 'workspace:*',
        },
      }),
      'utf-8',
    );
    await fs.writeFile(path.join(cliScriptsDir, 'cli.bats'), '#!/usr/bin/env bats\n', 'utf-8');

    // 6. Run discovery
    const result = await discover(tmpDir);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.descriptors).toHaveLength(4);

    const sharedDesc = result.descriptors.find((d) => d.name === '@ai-sdlc/shared');
    expect(sharedDesc).toBeDefined();
    expect(sharedDesc?.directory).toBe('packages/shared');
    expect(sharedDesc?.workspaceDependencies).toEqual([]);
    expect(sharedDesc?.scripts).toEqual({ build: 'tsc', test: 'vitest' });
    expect(sharedDesc?.hasBats).toBe(false);

    const domainDesc = result.descriptors.find((d) => d.name === '@ai-sdlc/domain');
    expect(domainDesc).toBeDefined();
    expect(domainDesc?.directory).toBe('packages/domain');
    expect(domainDesc?.workspaceDependencies).toEqual(['@ai-sdlc/shared']);
    expect(domainDesc?.scripts).toEqual({ build: 'tsc' });
    expect(domainDesc?.hasBats).toBe(false);

    const infraDesc = result.descriptors.find((d) => d.name === '@ai-sdlc/infrastructure');
    expect(infraDesc).toBeDefined();
    expect(infraDesc?.directory).toBe('packages/infrastructure');
    expect(infraDesc?.workspaceDependencies).toEqual(['@ai-sdlc/domain', '@ai-sdlc/shared']);
    expect(infraDesc?.scripts).toEqual({ build: 'tsc', test: 'vitest run' });
    expect(infraDesc?.hasBats).toBe(false);

    const cliDesc = result.descriptors.find((d) => d.name === '@ai-sdlc/cli');
    expect(cliDesc).toBeDefined();
    expect(cliDesc?.directory).toBe('apps/cli');
    expect(cliDesc?.workspaceDependencies).toEqual(['@ai-sdlc/infrastructure', '@ai-sdlc/shared']);
    expect(cliDesc?.scripts).toEqual({ 'test:bash': 'bats test.bats' });
    expect(cliDesc?.hasBats).toBe(true);
  });

  it('uses the deepest workspace directory as ownership metadata', async () => {
    const workspaceYaml = `packages:
  - 'packages/parent'
  - 'packages/parent/nested/child'
`;
    await fs.writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), workspaceYaml, 'utf-8');

    const parentDir = path.join(tmpDir, 'packages', 'parent');
    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(
      path.join(parentDir, 'package.json'),
      JSON.stringify({
        name: 'parent-pkg',
        scripts: { build: 'tsc' },
      }),
      'utf-8',
    );

    const childDir = path.join(tmpDir, 'packages', 'parent', 'nested', 'child');
    await fs.mkdir(childDir, { recursive: true });
    await fs.writeFile(
      path.join(childDir, 'package.json'),
      JSON.stringify({
        name: 'child-pkg',
        scripts: { test: 'vitest' },
      }),
      'utf-8',
    );
    await fs.writeFile(path.join(childDir, 'child.bats'), '# bats\n', 'utf-8');

    const result = await discover(tmpDir);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.descriptors).toHaveLength(2);

    const parentDesc = result.descriptors.find((d) => d.name === 'parent-pkg');
    expect(parentDesc?.directory).toBe('packages/parent');
    expect(parentDesc?.hasBats).toBe(false);

    const childDesc = result.descriptors.find((d) => d.name === 'child-pkg');
    expect(childDesc?.directory).toBe('packages/parent/nested/child');
    expect(childDesc?.hasBats).toBe(true);
  });

  it('fails closed on unreadable malformed or unnamed manifests', async () => {
    // Sub-case 1: Missing pnpm-workspace.yaml
    const resMissingYaml = await discover(tmpDir);
    expect(resMissingYaml.success).toBe(false);

    // Sub-case 2: Malformed pnpm-workspace.yaml
    await fs.writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), 'packages: [unclosed', 'utf-8');
    const resMalformedYaml = await discover(tmpDir);
    expect(resMalformedYaml.success).toBe(false);

    // Sub-case 3: Malformed package.json
    const validYaml = `packages:
  - 'packages/*'
`;
    await fs.writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), validYaml, 'utf-8');
    const pkgADir = path.join(tmpDir, 'packages', 'pkg-a');
    await fs.mkdir(pkgADir, { recursive: true });
    await fs.writeFile(path.join(pkgADir, 'package.json'), '{ invalid json', 'utf-8');

    const resMalformedPkg = await discover(tmpDir);
    expect(resMalformedPkg.success).toBe(false);

    // Sub-case 4: Unnamed package.json
    await fs.writeFile(
      path.join(pkgADir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc' } }),
      'utf-8',
    );
    const resUnnamed = await discover(tmpDir);
    expect(resUnnamed.success).toBe(false);

    // Sub-case 5: Invalid package name format
    await fs.writeFile(
      path.join(pkgADir, 'package.json'),
      JSON.stringify({ name: 'invalid name with spaces', scripts: {} }),
      'utf-8',
    );
    const resInvalidName = await discover(tmpDir);
    expect(resInvalidName.success).toBe(false);
  });

  it('fails closed on duplicate package names directories and unresolved workspace dependencies', async () => {
    const workspaceYaml = `packages:
  - 'packages/*'
  - 'extra/*'
`;
    await fs.writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), workspaceYaml, 'utf-8');

    // Sub-case 1: Duplicate package name in different directories
    const pkg1Dir = path.join(tmpDir, 'packages', 'foo');
    const pkg2Dir = path.join(tmpDir, 'extra', 'bar');
    await fs.mkdir(pkg1Dir, { recursive: true });
    await fs.mkdir(pkg2Dir, { recursive: true });

    await fs.writeFile(
      path.join(pkg1Dir, 'package.json'),
      JSON.stringify({ name: 'duplicate-name' }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(pkg2Dir, 'package.json'),
      JSON.stringify({ name: 'duplicate-name' }),
      'utf-8',
    );

    const resDuplicate = await discover(tmpDir);
    expect(resDuplicate.success).toBe(false);

    // Sub-case 2: Unresolved workspace dependency
    await fs.writeFile(
      path.join(pkg2Dir, 'package.json'),
      JSON.stringify({
        name: 'unique-name-2',
        dependencies: {
          'non-existent-pkg': 'workspace:*',
        },
      }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(pkg1Dir, 'package.json'),
      JSON.stringify({ name: 'unique-name-1' }),
      'utf-8',
    );

    const resUnresolved = await discover(tmpDir);
    expect(resUnresolved.success).toBe(false);
  });

  it('rejects unsupported workspace layouts and escaping paths', async () => {
    // Sub-case 1: Absolute path in workspace patterns
    await fs.writeFile(
      path.join(tmpDir, 'pnpm-workspace.yaml'),
      `packages:
  - '/etc/something'
`,
      'utf-8',
    );
    const resAbs = await discover(tmpDir);
    expect(resAbs.success).toBe(false);

    // Sub-case 2: Parent traversal in workspace patterns
    await fs.writeFile(
      path.join(tmpDir, 'pnpm-workspace.yaml'),
      `packages:
  - '../outside'
`,
      'utf-8',
    );
    const resParent = await discover(tmpDir);
    expect(resParent.success).toBe(false);

    // Sub-case 3: Unsupported recursive glob shape
    await fs.writeFile(
      path.join(tmpDir, 'pnpm-workspace.yaml'),
      `packages:
  - 'packages/**'
`,
      'utf-8',
    );
    const resGlob = await discover(tmpDir);
    expect(resGlob.success).toBe(false);

    // Sub-case 4: Unsupported partial wildcard shape
    await fs.writeFile(
      path.join(tmpDir, 'pnpm-workspace.yaml'),
      `packages:
  - 'packages/prefix-*'
`,
      'utf-8',
    );
    const resPartialGlob = await discover(tmpDir);
    expect(resPartialGlob.success).toBe(false);

    // Sub-case 5: Symlink escaping worktree root
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-pkg-'));
    try {
      await fs.writeFile(
        path.join(outsideDir, 'package.json'),
        JSON.stringify({ name: 'outside-pkg' }),
        'utf-8',
      );
      const pkgParentDir = path.join(tmpDir, 'packages');
      await fs.mkdir(pkgParentDir, { recursive: true });
      await fs.symlink(outsideDir, path.join(pkgParentDir, 'outside-symlink'), 'dir');
      await fs.writeFile(
        path.join(tmpDir, 'pnpm-workspace.yaml'),
        `packages:
  - 'packages/*'
`,
        'utf-8',
      );
      const resSymlink = await discover(tmpDir);
      expect(resSymlink.success).toBe(false);
      if (!resSymlink.success) {
        expect(resSymlink.reason).toContain('escapes worktree root');
      }
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('ignores .bats files inside hidden directories and non-bats ignored directories', async () => {
    const workspaceYaml = `packages:
  - 'packages/*'
`;
    await fs.writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), workspaceYaml, 'utf-8');

    const pkgDir = path.join(tmpDir, 'packages', 'pkg-hidden-bats');
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@ai-sdlc/pkg-hidden-bats',
        scripts: {},
      }),
      'utf-8',
    );

    // Add .bats file inside .vscode, .github, and node_modules
    const vscodeDir = path.join(pkgDir, '.vscode');
    const githubDir = path.join(pkgDir, '.github');
    const nodeModulesDir = path.join(pkgDir, 'node_modules');
    await fs.mkdir(vscodeDir, { recursive: true });
    await fs.mkdir(githubDir, { recursive: true });
    await fs.mkdir(nodeModulesDir, { recursive: true });

    await fs.writeFile(path.join(vscodeDir, 'test.bats'), '#!/usr/bin/env bats\n', 'utf-8');
    await fs.writeFile(path.join(githubDir, 'test.bats'), '#!/usr/bin/env bats\n', 'utf-8');
    await fs.writeFile(path.join(nodeModulesDir, 'test.bats'), '#!/usr/bin/env bats\n', 'utf-8');

    const result = await discover(tmpDir);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const desc = result.descriptors.find((d) => d.name === '@ai-sdlc/pkg-hidden-bats');
    expect(desc).toBeDefined();
    expect(desc?.hasBats).toBe(false);
  });

  it('ignores nested packages keys inside other YAML properties', async () => {
    const workspaceYaml = `otherProperty:
  packages:
    - 'ignored/*'
packages:
  - 'packages/*'
`;
    await fs.writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), workspaceYaml, 'utf-8');

    const pkgDir = path.join(tmpDir, 'packages', 'valid-pkg');
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@ai-sdlc/valid-pkg',
      }),
      'utf-8',
    );

    const ignoredDir = path.join(tmpDir, 'ignored', 'ignored-pkg');
    await fs.mkdir(ignoredDir, { recursive: true });
    await fs.writeFile(
      path.join(ignoredDir, 'package.json'),
      JSON.stringify({
        name: '@ai-sdlc/ignored-pkg',
      }),
      'utf-8',
    );

    const result = await discover(tmpDir);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.descriptors).toHaveLength(1);
    expect(result.descriptors[0]?.name).toBe('@ai-sdlc/valid-pkg');
  });

  it('correctly handles YAML comments including full-line, inline, and quoted hashes', async () => {
    const workspaceYaml = `
# Full-line comment before packages
# Another top comment
packages: # inline comment on packages declaration
  # Comment before first package pattern
  - 'packages/*' # inline comment after single-quoted pattern
  # Interleaved comment
  - "apps/*" # inline comment after double-quoted pattern
  # Trailing comment inside packages block
`;
    await fs.writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), workspaceYaml, 'utf-8');

    const pkg1Dir = path.join(tmpDir, 'packages', 'core-lib');
    await fs.mkdir(pkg1Dir, { recursive: true });
    await fs.writeFile(
      path.join(pkg1Dir, 'package.json'),
      JSON.stringify({ name: '@ai-sdlc/core-lib' }),
      'utf-8',
    );

    const appDir = path.join(tmpDir, 'apps', 'dashboard');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, 'package.json'),
      JSON.stringify({
        name: '@ai-sdlc/dashboard',
        dependencies: { '@ai-sdlc/core-lib': 'workspace:*' },
      }),
      'utf-8',
    );

    const result = await discover(tmpDir);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.descriptors).toHaveLength(2);
    expect(result.descriptors.map((d) => d.name)).toEqual([
      '@ai-sdlc/dashboard',
      '@ai-sdlc/core-lib',
    ]);
  });

  it('correctly handles inline array syntax with comments in pnpm-workspace.yaml', async () => {
    const workspaceYaml = `
# Header comment
packages: [ 'packages/*', "apps/*" ] # inline comment after bracketed list
`;
    await fs.writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), workspaceYaml, 'utf-8');

    const pkgDir = path.join(tmpDir, 'packages', 'bracket-pkg');
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@ai-sdlc/bracket-pkg' }),
      'utf-8',
    );

    const result = await discover(tmpDir);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.descriptors).toHaveLength(1);
    expect(result.descriptors[0]?.name).toBe('@ai-sdlc/bracket-pkg');
  });

  it('returns deterministic descriptors', async () => {
    const workspaceYaml1 = `packages:
  - 'packages/*'
  - 'apps/*'
`;
    await fs.writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), workspaceYaml1, 'utf-8');

    const dirs = [
      { dir: path.join(tmpDir, 'packages', 'z-pkg'), name: 'z-pkg' },
      { dir: path.join(tmpDir, 'packages', 'a-pkg'), name: 'a-pkg' },
      { dir: path.join(tmpDir, 'apps', 'm-app'), name: 'm-app' },
      { dir: path.join(tmpDir, 'apps', 'b-app'), name: 'b-app' },
    ];

    for (const d of dirs) {
      await fs.mkdir(d.dir, { recursive: true });
      await fs.writeFile(
        path.join(d.dir, 'package.json'),
        JSON.stringify({ name: d.name, scripts: { build: 'tsc' } }),
        'utf-8',
      );
    }

    const res1 = await discover(tmpDir);
    expect(res1.success).toBe(true);

    // Now change order of patterns in pnpm-workspace.yaml
    const workspaceYaml2 = `packages:
  - 'apps/*'
  - 'packages/*'
`;
    await fs.writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), workspaceYaml2, 'utf-8');

    const res2 = await discover(tmpDir);
    expect(res2.success).toBe(true);

    if (res1.success && res2.success) {
      expect(res1.descriptors).toEqual(res2.descriptors);
    }
  });

  it('correctly resolves workspace dependency aliases including unversioned and scoped targets', async () => {
    const workspaceYaml = `packages:
  - 'packages/*'
`;
    await fs.writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), workspaceYaml, 'utf-8');

    // Shared package
    const sharedDir = path.join(tmpDir, 'packages', 'shared');
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(
      path.join(sharedDir, 'package.json'),
      JSON.stringify({ name: '@ai-sdlc/shared' }),
      'utf-8',
    );

    // Utils package
    const utilsDir = path.join(tmpDir, 'packages', 'utils');
    await fs.mkdir(utilsDir, { recursive: true });
    await fs.writeFile(
      path.join(utilsDir, 'package.json'),
      JSON.stringify({ name: 'my-utils' }),
      'utf-8',
    );

    // Consumer package using various alias forms
    const consumerDir = path.join(tmpDir, 'packages', 'consumer');
    await fs.mkdir(consumerDir, { recursive: true });
    await fs.writeFile(
      path.join(consumerDir, 'package.json'),
      JSON.stringify({
        name: 'consumer-pkg',
        dependencies: {
          'unversioned-alias': 'workspace:my-utils',
          'versioned-alias': 'workspace:my-utils@^1.0.0',
          'unversioned-scoped-alias': 'workspace:@ai-sdlc/shared',
          'versioned-scoped-alias': 'workspace:@ai-sdlc/shared@*',
        },
      }),
      'utf-8',
    );

    const result = await discover(tmpDir);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const consumer = result.descriptors.find((d) => d.name === 'consumer-pkg');
    expect(consumer).toBeDefined();
    expect(consumer?.workspaceDependencies).toEqual(['@ai-sdlc/shared', 'my-utils']);
  });

  it('discovers all packages in the actual repository workspace', async () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const result = await discover(repoRoot);

    expect(result.success).toBe(true);
    if (!result.success) {
      expect(result.reason).toBeUndefined();
      return;
    }

    const names = result.descriptors.map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        '@ai-sdlc/api',
        '@ai-sdlc/application',
        '@ai-sdlc/cli',
        '@ai-sdlc/domain',
        '@ai-sdlc/infrastructure',
        '@ai-sdlc/shared',
        '@ai-sdlc/web',
      ]),
    );
  });
});

describe('discoverWorkspacePackagesSync synchronous execution', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-discovery-sync-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('executes synchronously and returns result object directly without returning a Promise', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'pnpm-workspace.yaml'),
      `packages:\n  - 'packages/*'\n`,
      'utf-8',
    );
    const pkgDir = path.join(tmpDir, 'packages', 'sync-pkg');
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@ai-sdlc/sync-pkg', scripts: { test: 'vitest' } }),
      'utf-8',
    );

    const result = discoverWorkspacePackagesSync(tmpDir);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.descriptors).toHaveLength(1);
    expect(result.descriptors[0]?.name).toBe('@ai-sdlc/sync-pkg');
  });
});
