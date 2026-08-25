import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkspacePackageDescriptor } from '@ai-sdlc/application';

export type WorkspacePackageDiscoverySuccess = {
  success: true;
  descriptors: WorkspacePackageDescriptor[];
};

export type WorkspacePackageDiscoveryFailure = {
  success: false;
  reason: string;
  error?: string;
};

export type WorkspacePackageDiscoveryResult =
  | WorkspacePackageDiscoverySuccess
  | WorkspacePackageDiscoveryFailure;

const SAFE_NAME_REGEX = /^(@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/;

const IGNORED_BATS_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  '.cache',
  '.turbo',
  '.next',
  '.ai-tmp',
  '.ai-runs',
]);

/**
 * Strip YAML comments outside single/double quotes.
 */
function stripYamlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let result = '';

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      result += char;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      result += char;
    } else if (char === '#' && !inSingle && !inDouble) {
      break;
    } else {
      result += char;
    }
  }

  return result;
}

/**
 * Parse package glob patterns from pnpm-workspace.yaml content.
 */
function parseWorkspaceYamlPackages(
  content: string,
): { success: true; patterns: string[] } | { success: false; reason: string } {
  const lines = content.split(/\r?\n/);
  let inPackagesSection = false;
  const patterns: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? '';
    const stripped = stripYamlComment(rawLine);
    const trimmed = stripped.trim();

    if (!trimmed) {
      continue;
    }

    if (!inPackagesSection) {
      if (/^packages\s*:/.test(stripped)) {
        inPackagesSection = true;
        const afterColon = trimmed.slice(trimmed.indexOf(':') + 1).trim();
        if (afterColon.startsWith('[') && afterColon.endsWith(']')) {
          const inner = afterColon.slice(1, -1).trim();
          if (inner.length > 0) {
            const items = inner.split(',');
            for (const item of items) {
              const cleaned = item.trim().replace(/^['"]|['"]$/g, '');
              if (cleaned) {
                patterns.push(cleaned);
              }
            }
          }
          break;
        } else if (afterColon.length > 0) {
          return {
            success: false,
            reason: 'Malformed packages declaration in pnpm-workspace.yaml',
          };
        }
      }
    } else {
      // Check if we hit another top-level section (non-indented line without '-')
      if (
        /^[a-zA-Z0-9_-]+\s*:/.test(stripped) &&
        !stripped.startsWith(' ') &&
        !stripped.startsWith('\t')
      ) {
        break;
      }

      if (trimmed.startsWith('-')) {
        const itemVal = trimmed
          .slice(1)
          .trim()
          .replace(/^['"]|['"]$/g, '');
        if (itemVal) {
          patterns.push(itemVal);
        }
      }
    }
  }

  if (!inPackagesSection || patterns.length === 0) {
    return { success: false, reason: 'No packages pattern found in pnpm-workspace.yaml' };
  }

  return { success: true, patterns };
}

/**
 * Validates a workspace pattern and returns normalized path segments or an error.
 */
function validatePattern(
  pattern: string,
): { success: true; segments: string[] } | { success: false; reason: string } {
  if (typeof pattern !== 'string' || !pattern.trim()) {
    return { success: false, reason: 'Empty workspace pattern' };
  }

  const trimmed = pattern.trim().replace(/\\/g, '/');

  // Reject absolute paths
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) {
    return { success: false, reason: `Absolute path pattern is not supported: "${pattern}"` };
  }

  const rawSegments = trimmed.split('/');
  const segments: string[] = [];

  for (const seg of rawSegments) {
    if (!seg || seg === '.') {
      continue;
    }
    if (seg === '..') {
      return {
        success: false,
        reason: `Parent traversal in pattern is not supported: "${pattern}"`,
      };
    }
    if (seg === '**') {
      return { success: false, reason: `Recursive glob "**" is not supported: "${pattern}"` };
    }
    if (
      seg !== '*' &&
      (seg.includes('*') || seg.includes('?') || seg.includes('[') || seg.includes('{'))
    ) {
      return { success: false, reason: `Unsupported glob shape in pattern: "${pattern}"` };
    }
    segments.push(seg);
  }

  if (segments.length === 0) {
    return { success: false, reason: `Invalid empty pattern: "${pattern}"` };
  }

  return { success: true, segments };
}

/**
 * Extract target package name from a workspace: dependency specification.
 */
function extractWorkspaceDependencyTarget(depKey: string, depVal: string): string {
  const rawTarget = depVal.slice('workspace:'.length).trim();
  if (!rawTarget || rawTarget === '*' || rawTarget === '^' || rawTarget === '~') {
    return depKey;
  }
  if (/^[~^<>=]|^v?\d+(?:\.\d+)*(?:[a-zA-Z0-9_.+-]*)$/.test(rawTarget)) {
    return depKey;
  }
  if (rawTarget.startsWith('@')) {
    const match = rawTarget.match(/^(@[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)(?:@.*)?$/);
    if (match && match[1]) {
      return match[1];
    }
  } else {
    const match = rawTarget.match(/^([a-zA-Z0-9_.-]+)(?:@.*)?$/);
    if (match && match[1]) {
      return match[1];
    }
  }
  return depKey;
}

/**
 * Asynchronously expand a validated pattern's segments into matched directory paths relative to worktreeRoot.
 */
async function expandPatternSegmentsAsync(
  worktreeRoot: string,
  segments: string[],
): Promise<string[]> {
  let currentDirs = [''];

  for (const seg of segments) {
    const nextDirs: string[] = [];

    for (const cur of currentDirs) {
      const fullCurPath = path.join(worktreeRoot, cur);
      try {
        const stat = await fs.stat(fullCurPath);
        if (!stat.isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }

      if (seg === '*') {
        try {
          const entries = await fs.readdir(fullCurPath, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() || entry.isSymbolicLink()) {
              const rel = cur ? `${cur}/${entry.name}` : entry.name;
              nextDirs.push(rel);
            }
          }
        } catch {
          // ignore directory read error on wildcards
        }
      } else {
        const targetPath = path.join(fullCurPath, seg);
        try {
          const stat = await fs.stat(targetPath);
          if (stat.isDirectory()) {
            const rel = cur ? `${cur}/${seg}` : seg;
            nextDirs.push(rel);
          }
        } catch {
          // ignore
        }
      }
    }

    currentDirs = nextDirs;
  }

  return currentDirs;
}

/**
 * Synchronously expand a validated pattern's segments into matched directory paths relative to worktreeRoot.
 */
function expandPatternSegmentsSync(worktreeRoot: string, segments: string[]): string[] {
  let currentDirs = [''];

  for (const seg of segments) {
    const nextDirs: string[] = [];

    for (const cur of currentDirs) {
      const fullCurPath = path.join(worktreeRoot, cur);
      try {
        const stat = statSync(fullCurPath);
        if (!stat.isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }

      if (seg === '*') {
        try {
          const entries = readdirSync(fullCurPath, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() || entry.isSymbolicLink()) {
              const rel = cur ? `${cur}/${entry.name}` : entry.name;
              nextDirs.push(rel);
            }
          }
        } catch {
          // ignore directory read error on wildcards
        }
      } else {
        const targetPath = path.join(fullCurPath, seg);
        try {
          const stat = statSync(targetPath);
          if (stat.isDirectory()) {
            const rel = cur ? `${cur}/${seg}` : seg;
            nextDirs.push(rel);
          }
        } catch {
          // ignore
        }
      }
    }

    currentDirs = nextDirs;
  }

  return currentDirs;
}

/**
 * Asynchronously check if a package directory contains any .bats files, excluding nested packages and ignored dirs.
 */
async function packageHasBatsAsync(
  worktreeRoot: string,
  packageDir: string,
  allPackageDirs: Set<string>,
): Promise<boolean> {
  async function walk(currentRelDir: string): Promise<boolean> {
    const fullDirPath = path.join(worktreeRoot, currentRelDir);
    let entries: Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }>;
    try {
      entries = await fs.readdir(fullDirPath, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      const name = String(entry.name);
      if ((name.startsWith('.') && name !== '.bats') || IGNORED_BATS_DIRECTORIES.has(name)) {
        continue;
      }

      const childRelDir = `${currentRelDir}/${name}`;

      if (entry.isDirectory()) {
        // Do not traverse into another package's directory boundary
        if (allPackageDirs.has(childRelDir)) {
          continue;
        }
        if (await walk(childRelDir)) {
          return true;
        }
      } else if (entry.isFile() && name.endsWith('.bats')) {
        return true;
      }
    }

    return false;
  }

  return walk(packageDir);
}

/**
 * Synchronously check if a package directory contains any .bats files, excluding nested packages and ignored dirs.
 */
function packageHasBatsSync(
  worktreeRoot: string,
  packageDir: string,
  allPackageDirs: Set<string>,
): boolean {
  function walk(currentRelDir: string): boolean {
    const fullDirPath = path.join(worktreeRoot, currentRelDir);
    let entries: Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }>;
    try {
      entries = readdirSync(fullDirPath, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      const name = String(entry.name);
      if ((name.startsWith('.') && name !== '.bats') || IGNORED_BATS_DIRECTORIES.has(name)) {
        continue;
      }

      const childRelDir = `${currentRelDir}/${name}`;

      if (entry.isDirectory()) {
        // Do not traverse into another package's directory boundary
        if (allPackageDirs.has(childRelDir)) {
          continue;
        }
        if (walk(childRelDir)) {
          return true;
        }
      } else if (entry.isFile() && name.endsWith('.bats')) {
        return true;
      }
    }

    return false;
  }

  return walk(packageDir);
}

/**
 * Synchronous implementation of workspace package discovery.
 */
export function discoverWorkspacePackagesSync(
  worktreeRoot: string,
): WorkspacePackageDiscoveryResult {
  if (!worktreeRoot || typeof worktreeRoot !== 'string' || !worktreeRoot.trim()) {
    return { success: false, reason: 'Invalid worktree root path' };
  }

  const resolvedRoot = path.resolve(worktreeRoot);
  let realRoot: string;
  try {
    const rootStat = statSync(resolvedRoot);
    if (!rootStat.isDirectory()) {
      return { success: false, reason: `Worktree root is not a directory: ${resolvedRoot}` };
    }
    realRoot = realpathSync(resolvedRoot);
  } catch (err) {
    return {
      success: false,
      reason: `Cannot inspect worktree root: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const workspaceYamlPath = path.join(resolvedRoot, 'pnpm-workspace.yaml');
  let yamlContent: string;
  try {
    yamlContent = readFileSync(workspaceYamlPath, 'utf-8');
  } catch {
    return {
      success: false,
      reason: `Missing pnpm-workspace.yaml in ${resolvedRoot}`,
    };
  }

  const parsedYaml = parseWorkspaceYamlPackages(yamlContent);
  if (!parsedYaml.success) {
    return { success: false, reason: parsedYaml.reason };
  }

  const candidateDirs = new Set<string>();

  for (const pattern of parsedYaml.patterns) {
    const validated = validatePattern(pattern);
    if (!validated.success) {
      return { success: false, reason: validated.reason };
    }

    const matched = expandPatternSegmentsSync(resolvedRoot, validated.segments);
    for (const dir of matched) {
      const candidatePath = path.join(resolvedRoot, dir);
      const pkgJsonPath = path.join(candidatePath, 'package.json');
      try {
        const stat = statSync(pkgJsonPath);
        if (!stat.isFile()) {
          continue;
        }
      } catch {
        continue;
      }

      // Verify path does not escape worktree
      let realDir: string;
      try {
        realDir = realpathSync(candidatePath);
      } catch {
        return { success: false, reason: `Package directory escapes worktree root: ${dir}` };
      }
      const relFromRoot = path.relative(realRoot, realDir);
      if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
        return { success: false, reason: `Package directory escapes worktree root: ${dir}` };
      }
      candidateDirs.add(dir.replace(/\\/g, '/'));
    }
  }

  if (candidateDirs.size === 0) {
    return { success: false, reason: 'No workspace packages found matching workspace patterns' };
  }

  const seenNames = new Map<string, string>();
  const descriptors: WorkspacePackageDescriptor[] = [];

  for (const dir of candidateDirs) {
    const pkgJsonPath = path.join(resolvedRoot, dir, 'package.json');
    let pkgJsonRaw: string;
    try {
      pkgJsonRaw = readFileSync(pkgJsonPath, 'utf-8');
    } catch (err) {
      return {
        success: false,
        reason: `Unreadable manifest in ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let pkgJson: Record<string, unknown>;
    try {
      pkgJson = JSON.parse(pkgJsonRaw);
    } catch (err) {
      return {
        success: false,
        reason: `Malformed package.json in ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!pkgJson || typeof pkgJson !== 'object' || Array.isArray(pkgJson)) {
      return { success: false, reason: `Invalid package.json object in ${dir}` };
    }

    if (typeof pkgJson.name !== 'string' || !pkgJson.name.trim()) {
      return { success: false, reason: `Unnamed package manifest in ${dir}` };
    }

    const pkgName = pkgJson.name.trim();
    if (!SAFE_NAME_REGEX.test(pkgName)) {
      return { success: false, reason: `Invalid package name "${pkgName}" in ${dir}` };
    }

    if (seenNames.has(pkgName)) {
      return {
        success: false,
        reason: `Duplicate package name "${pkgName}" found in "${dir}" and "${seenNames.get(pkgName)}"`,
      };
    }
    seenNames.set(pkgName, dir);

    // Scripts
    const scripts: Record<string, string> = {};
    if (pkgJson.scripts !== undefined && pkgJson.scripts !== null) {
      if (typeof pkgJson.scripts !== 'object' || Array.isArray(pkgJson.scripts)) {
        return { success: false, reason: `Invalid scripts definition in ${dir}` };
      }
      for (const [scriptName, scriptCmd] of Object.entries(
        pkgJson.scripts as Record<string, unknown>,
      )) {
        if (typeof scriptCmd === 'string') {
          scripts[scriptName] = scriptCmd;
        }
      }
    }

    // Dependencies across all four sections
    const workspaceDeps = new Set<string>();
    const depSections = [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ] as const;

    for (const section of depSections) {
      const depObj = pkgJson[section];
      if (depObj !== undefined && depObj !== null) {
        if (typeof depObj !== 'object' || Array.isArray(depObj)) {
          return { success: false, reason: `Invalid ${section} in ${dir}` };
        }
        for (const [depKey, depVal] of Object.entries(depObj as Record<string, unknown>)) {
          if (typeof depVal === 'string' && depVal.startsWith('workspace:')) {
            const targetName = extractWorkspaceDependencyTarget(depKey, depVal);
            workspaceDeps.add(targetName);
          }
        }
      }
    }

    const hasBats = packageHasBatsSync(resolvedRoot, dir, candidateDirs);

    descriptors.push({
      name: pkgName,
      directory: dir,
      workspaceDependencies: Array.from(workspaceDeps).sort(),
      scripts,
      hasBats,
    });
  }

  // Validate that all workspace dependencies are resolved within the workspace
  const allNames = new Set(descriptors.map((d) => d.name));
  for (const desc of descriptors) {
    for (const dep of desc.workspaceDependencies ?? []) {
      if (!allNames.has(dep)) {
        return {
          success: false,
          reason: `Unresolved workspace dependency: "${dep}" required by "${desc.name}" was not found in workspace`,
        };
      }
    }
  }

  // Deterministic ordering by directory
  descriptors.sort((a, b) => a.directory.localeCompare(b.directory));

  return {
    success: true,
    descriptors,
  };
}

/**
 * Asynchronous discoverWorkspacePackages implementation using node:fs/promises.
 */
export async function discoverWorkspacePackages(
  worktreeRoot: string,
): Promise<WorkspacePackageDiscoveryResult> {
  if (!worktreeRoot || typeof worktreeRoot !== 'string' || !worktreeRoot.trim()) {
    return { success: false, reason: 'Invalid worktree root path' };
  }

  const resolvedRoot = path.resolve(worktreeRoot);
  let realRoot: string;
  try {
    const rootStat = await fs.stat(resolvedRoot);
    if (!rootStat.isDirectory()) {
      return { success: false, reason: `Worktree root is not a directory: ${resolvedRoot}` };
    }
    realRoot = await fs.realpath(resolvedRoot);
  } catch (err) {
    return {
      success: false,
      reason: `Cannot inspect worktree root: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const workspaceYamlPath = path.join(resolvedRoot, 'pnpm-workspace.yaml');
  let yamlContent: string;
  try {
    yamlContent = await fs.readFile(workspaceYamlPath, 'utf-8');
  } catch {
    return {
      success: false,
      reason: `Missing pnpm-workspace.yaml in ${resolvedRoot}`,
    };
  }

  const parsedYaml = parseWorkspaceYamlPackages(yamlContent);
  if (!parsedYaml.success) {
    return { success: false, reason: parsedYaml.reason };
  }

  const candidateDirs = new Set<string>();

  for (const pattern of parsedYaml.patterns) {
    const validated = validatePattern(pattern);
    if (!validated.success) {
      return { success: false, reason: validated.reason };
    }

    const matched = await expandPatternSegmentsAsync(resolvedRoot, validated.segments);
    for (const dir of matched) {
      const candidatePath = path.join(resolvedRoot, dir);
      const pkgJsonPath = path.join(candidatePath, 'package.json');
      try {
        const stat = await fs.stat(pkgJsonPath);
        if (!stat.isFile()) {
          continue;
        }
      } catch {
        continue;
      }

      // Verify path does not escape worktree
      let realDir: string;
      try {
        realDir = await fs.realpath(candidatePath);
      } catch {
        return { success: false, reason: `Package directory escapes worktree root: ${dir}` };
      }
      const relFromRoot = path.relative(realRoot, realDir);
      if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
        return { success: false, reason: `Package directory escapes worktree root: ${dir}` };
      }
      candidateDirs.add(dir.replace(/\\/g, '/'));
    }
  }

  if (candidateDirs.size === 0) {
    return { success: false, reason: 'No workspace packages found matching workspace patterns' };
  }

  const seenNames = new Map<string, string>();
  const descriptors: WorkspacePackageDescriptor[] = [];

  for (const dir of candidateDirs) {
    const pkgJsonPath = path.join(resolvedRoot, dir, 'package.json');
    let pkgJsonRaw: string;
    try {
      pkgJsonRaw = await fs.readFile(pkgJsonPath, 'utf-8');
    } catch (err) {
      return {
        success: false,
        reason: `Unreadable manifest in ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let pkgJson: Record<string, unknown>;
    try {
      pkgJson = JSON.parse(pkgJsonRaw);
    } catch (err) {
      return {
        success: false,
        reason: `Malformed package.json in ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!pkgJson || typeof pkgJson !== 'object' || Array.isArray(pkgJson)) {
      return { success: false, reason: `Invalid package.json object in ${dir}` };
    }

    if (typeof pkgJson.name !== 'string' || !pkgJson.name.trim()) {
      return { success: false, reason: `Unnamed package manifest in ${dir}` };
    }

    const pkgName = pkgJson.name.trim();
    if (!SAFE_NAME_REGEX.test(pkgName)) {
      return { success: false, reason: `Invalid package name "${pkgName}" in ${dir}` };
    }

    if (seenNames.has(pkgName)) {
      return {
        success: false,
        reason: `Duplicate package name "${pkgName}" found in "${dir}" and "${seenNames.get(pkgName)}"`,
      };
    }
    seenNames.set(pkgName, dir);

    // Scripts
    const scripts: Record<string, string> = {};
    if (pkgJson.scripts !== undefined && pkgJson.scripts !== null) {
      if (typeof pkgJson.scripts !== 'object' || Array.isArray(pkgJson.scripts)) {
        return { success: false, reason: `Invalid scripts definition in ${dir}` };
      }
      for (const [scriptName, scriptCmd] of Object.entries(
        pkgJson.scripts as Record<string, unknown>,
      )) {
        if (typeof scriptCmd === 'string') {
          scripts[scriptName] = scriptCmd;
        }
      }
    }

    // Dependencies across all four sections
    const workspaceDeps = new Set<string>();
    const depSections = [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ] as const;

    for (const section of depSections) {
      const depObj = pkgJson[section];
      if (depObj !== undefined && depObj !== null) {
        if (typeof depObj !== 'object' || Array.isArray(depObj)) {
          return { success: false, reason: `Invalid ${section} in ${dir}` };
        }
        for (const [depKey, depVal] of Object.entries(depObj as Record<string, unknown>)) {
          if (typeof depVal === 'string' && depVal.startsWith('workspace:')) {
            const targetName = extractWorkspaceDependencyTarget(depKey, depVal);
            workspaceDeps.add(targetName);
          }
        }
      }
    }

    const hasBats = await packageHasBatsAsync(resolvedRoot, dir, candidateDirs);

    descriptors.push({
      name: pkgName,
      directory: dir,
      workspaceDependencies: Array.from(workspaceDeps).sort(),
      scripts,
      hasBats,
    });
  }

  // Validate that all workspace dependencies are resolved within the workspace
  const allNames = new Set(descriptors.map((d) => d.name));
  for (const desc of descriptors) {
    for (const dep of desc.workspaceDependencies ?? []) {
      if (!allNames.has(dep)) {
        return {
          success: false,
          reason: `Unresolved workspace dependency: "${dep}" required by "${desc.name}" was not found in workspace`,
        };
      }
    }
  }

  // Deterministic ordering by directory
  descriptors.sort((a, b) => a.directory.localeCompare(b.directory));

  return {
    success: true,
    descriptors,
  };
}

export const discoverWorkspacePackageDescriptors = discoverWorkspacePackages;
