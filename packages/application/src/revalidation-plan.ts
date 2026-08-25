import type { ValidationCommand } from './ports/validation-port.js';

export interface WorkspacePackageDescriptor {
  name: string;
  directory: string;
  workspaceDependencies?: string[];
  scripts?: string[] | Record<string, string>;
  hasBats?: boolean;
}

export type FullValidationReason =
  | 'first_iteration'
  | 'pr_ready'
  | 'missing_baseline'
  | 'empty_changed_files'
  | 'multiple_packages'
  | 'outside_package'
  | 'upstream_package'
  | 'ambiguous_ownership'
  | 'invalid_descriptor'
  | 'unresolved_dependency'
  | 'cyclic_dependency'
  | 'unknown_command';

export type RevalidationPlan =
  | {
      mode: 'full';
      reason: FullValidationReason;
      commands: ValidationCommand[];
      tiers?: string[][];
    }
  | {
      mode: 'narrow';
      changedPackage: string;
      narrowedPackages: string[];
      commands: ValidationCommand[];
      tiers?: string[][];
    };

export interface PlanRevalidationInput {
  changedPaths: string[];
  iterationIndex: number;
  hasStepBaseline: boolean;
  isPrReady?: boolean;
  descriptors: WorkspacePackageDescriptor[];
  commands: ValidationCommand[];
  tiers?: string[][];
}

const INELIGIBLE_UPSTREAM_PACKAGES = new Set(['@ai-sdlc/shared', '@ai-sdlc/domain']);

const SAFE_NAME_REGEX = /^(@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/;
const SAFE_DIR_REGEX = /^[a-zA-Z0-9_.-]+(\/[a-zA-Z0-9_.-]+)*$/;

function normalizeRepoRelativePath(rawPath: string): string | null {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return null;
  }
  let p = rawPath.trim().replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) {
    return null;
  }
  while (p.startsWith('./')) {
    p = p.slice(2);
  }
  const parts = p.split('/');
  const normalizedParts: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      if (normalizedParts.length === 0) {
        return null;
      }
      normalizedParts.pop();
    } else {
      normalizedParts.push(part);
    }
  }
  if (normalizedParts.length === 0) {
    return null;
  }
  return normalizedParts.join('/');
}

type CommandSemanticRole =
  | { role: 'build' }
  | { role: 'lint' }
  | { role: 'typecheck' }
  | { role: 'test' }
  | { role: 'bash_test' }
  | { role: 'boundaries' };

function classifyCommand(cmd: ValidationCommand): CommandSemanticRole | null {
  const tokens = Array.isArray(cmd)
    ? cmd.map((t) => t.trim()).filter(Boolean)
    : cmd.trim().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return null;
  }

  const firstToken = tokens[0];
  if (firstToken === 'pnpm') {
    const sub = tokens.slice(1);
    if (sub.length === 0) {
      return null;
    }

    const t0 = sub[0];
    const t1 = sub[1];

    if (
      sub.length === 1 &&
      (t0 === 'build' || t0 === 'lint' || t0 === 'typecheck' || t0 === 'test')
    ) {
      return { role: t0 };
    }

    if (
      sub.length === 2 &&
      (t0 === '-r' || t0 === 'run') &&
      (t1 === 'build' || t1 === 'lint' || t1 === 'typecheck' || t1 === 'test')
    ) {
      return { role: t1 };
    }

    if (t0 === 'test:bash' || (t0 === 'run' && t1 === 'test:bash')) {
      return { role: 'bash_test' };
    }

    if (t0 === 'boundaries' || (t0 === 'run' && t1 === 'boundaries')) {
      return { role: 'boundaries' };
    }

    if (t0 === 'exec' && t1 === 'eslint') {
      return { role: 'lint' };
    }
  }

  return null;
}

function rewriteCommand(
  cmd: ValidationCommand,
  role: CommandSemanticRole,
  seedPackage: string,
  narrowedPackages: string[],
  descriptorMap: Map<string, WorkspacePackageDescriptor>,
  hasBatsInClosure: boolean,
): ValidationCommand | null {
  const isLeaf = narrowedPackages.length === 1 && narrowedPackages[0] === seedPackage;
  const filter = isLeaf ? seedPackage : `...${seedPackage}`;
  const isArray = Array.isArray(cmd);

  switch (role.role) {
    case 'build':
      return isArray ? ['pnpm', '--filter', filter, 'build'] : `pnpm --filter ${filter} build`;

    case 'typecheck':
      return isArray
        ? ['pnpm', '--filter', filter, 'typecheck']
        : `pnpm --filter ${filter} typecheck`;

    case 'test':
      return isArray ? ['pnpm', '--filter', filter, 'test'] : `pnpm --filter ${filter} test`;

    case 'lint': {
      const closureDirs = narrowedPackages
        .map((pkgName) => descriptorMap.get(pkgName)?.directory)
        .filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);

      return isArray
        ? ['pnpm', 'exec', 'eslint', ...closureDirs, '--max-warnings=0']
        : `pnpm exec eslint ${closureDirs.join(' ')} --max-warnings=0`;
    }

    case 'bash_test':
      if (!hasBatsInClosure) {
        return null;
      }
      return isArray ? ['pnpm', 'test:bash'] : 'pnpm test:bash';

    case 'boundaries':
      return cmd;
  }
}

/**
 * Pure revalidation scope planner.
 * Determines whether a mid-implement revalidation can be narrowed to a single changed
 * workspace package and its reverse transitive dependents, or whether it must fall back to full validation.
 */
export function planRevalidation(input: PlanRevalidationInput): RevalidationPlan {
  const { changedPaths, iterationIndex, hasStepBaseline, isPrReady, descriptors, commands, tiers } =
    input;

  const fullPlan = (reason: FullValidationReason): RevalidationPlan => ({
    mode: 'full',
    reason,
    commands,
    ...(tiers !== undefined ? { tiers } : {}),
  });

  // 0. Eligibility: pr-ready iteration must run full validation
  if (isPrReady) {
    return fullPlan('pr_ready');
  }

  // 1. Eligibility: must have baseline
  if (!hasStepBaseline) {
    return fullPlan('missing_baseline');
  }

  // 2. Eligibility: must be iteration > 1
  if (iterationIndex <= 1) {
    return fullPlan('first_iteration');
  }

  // 3. Eligibility: changed paths must not be empty
  if (!changedPaths || changedPaths.length === 0) {
    return fullPlan('empty_changed_files');
  }

  // 4. Validate descriptors
  const descriptorMap = new Map<string, WorkspacePackageDescriptor>();
  const directoryMap = new Map<string, WorkspacePackageDescriptor>();

  for (const desc of descriptors) {
    if (!desc.name || !SAFE_NAME_REGEX.test(desc.name)) {
      return fullPlan('invalid_descriptor');
    }
    const normDir = normalizeRepoRelativePath(desc.directory);
    if (!normDir || !SAFE_DIR_REGEX.test(normDir)) {
      return fullPlan('invalid_descriptor');
    }

    if (descriptorMap.has(desc.name)) {
      return fullPlan('ambiguous_ownership');
    }
    if (directoryMap.has(normDir)) {
      return fullPlan('ambiguous_ownership');
    }

    const normalizedDesc: WorkspacePackageDescriptor = {
      ...desc,
      directory: normDir,
    };
    descriptorMap.set(desc.name, normalizedDesc);
    directoryMap.set(normDir, normalizedDesc);
  }

  // 5. Validate workspace graph (unresolved dependencies & cycles)
  const directDependentsMap = new Map<string, Set<string>>();
  for (const name of descriptorMap.keys()) {
    directDependentsMap.set(name, new Set());
  }

  for (const desc of descriptorMap.values()) {
    const deps = new Set(desc.workspaceDependencies ?? []);
    for (const dep of deps) {
      if (!descriptorMap.has(dep)) {
        return fullPlan('unresolved_dependency');
      }
      directDependentsMap.get(dep)?.add(desc.name);
    }
  }

  // Cycle detection across whole workspace graph using Kahn's algorithm
  const inDegrees = new Map<string, number>();
  for (const desc of descriptorMap.values()) {
    inDegrees.set(desc.name, new Set(desc.workspaceDependencies ?? []).size);
  }
  const queue: string[] = [];
  for (const [name, deg] of inDegrees.entries()) {
    if (deg === 0) {
      queue.push(name);
    }
  }
  let visitedCount = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    visitedCount++;
    const dependents = directDependentsMap.get(current) ?? new Set();
    for (const dep of dependents) {
      const currentDeg = inDegrees.get(dep) ?? 0;
      const nextDeg = currentDeg - 1;
      inDegrees.set(dep, nextDeg);
      if (nextDeg === 0) {
        queue.push(dep);
      }
    }
  }
  if (visitedCount !== descriptorMap.size) {
    return fullPlan('cyclic_dependency');
  }

  // 6. Map changed paths to packages (deepest directory boundary)
  const sortedDescsByDirDepth = [...descriptorMap.values()].sort(
    (a, b) => b.directory.length - a.directory.length,
  );

  const matchedPackages = new Set<string>();

  for (const rawPath of changedPaths) {
    const normPath = normalizeRepoRelativePath(rawPath);
    if (!normPath) {
      return fullPlan('outside_package');
    }

    let matchedDesc: WorkspacePackageDescriptor | null = null;
    for (const desc of sortedDescsByDirDepth) {
      if (normPath === desc.directory || normPath.startsWith(desc.directory + '/')) {
        matchedDesc = desc;
        break;
      }
    }

    if (!matchedDesc) {
      return fullPlan('outside_package');
    }

    matchedPackages.add(matchedDesc.name);
  }

  if (matchedPackages.size === 0) {
    return fullPlan('outside_package');
  }

  if (matchedPackages.size > 1) {
    return fullPlan('multiple_packages');
  }

  const seedPackage = matchedPackages.values().next().value as string;

  // 7. Check if seed is an ineligible upstream package
  if (INELIGIBLE_UPSTREAM_PACKAGES.has(seedPackage)) {
    return fullPlan('upstream_package');
  }

  // 8. Compute reverse transitive closure of seedPackage
  const closureSet = new Set<string>();
  const bfsQueue: string[] = [seedPackage];
  closureSet.add(seedPackage);

  while (bfsQueue.length > 0) {
    const curr = bfsQueue.shift();
    if (!curr) {
      break;
    }
    const dependents = directDependentsMap.get(curr) ?? new Set();
    for (const dep of dependents) {
      if (!closureSet.has(dep)) {
        closureSet.add(dep);
        bfsQueue.push(dep);
      }
    }
  }

  // 9. Topologically sort the closure with package name as deterministic tie-breaker
  const closureInDegrees = new Map<string, number>();
  for (const pkgName of closureSet) {
    const desc = descriptorMap.get(pkgName);
    if (!desc) {
      return fullPlan('invalid_descriptor');
    }
    const depsInClosure = new Set(
      (desc.workspaceDependencies ?? []).filter((dep) => closureSet.has(dep)),
    );
    closureInDegrees.set(pkgName, depsInClosure.size);
  }

  const readyQueue: string[] = [];
  for (const [pkgName, deg] of closureInDegrees.entries()) {
    if (deg === 0) {
      readyQueue.push(pkgName);
    }
  }
  readyQueue.sort((a, b) => a.localeCompare(b));

  const narrowedPackages: string[] = [];
  while (readyQueue.length > 0) {
    const current = readyQueue.shift();
    if (!current) {
      break;
    }
    narrowedPackages.push(current);

    const dependents = directDependentsMap.get(current) ?? new Set();
    for (const dep of dependents) {
      if (closureSet.has(dep)) {
        const deg = (closureInDegrees.get(dep) ?? 1) - 1;
        closureInDegrees.set(dep, deg);
        if (deg === 0) {
          readyQueue.push(dep);
          readyQueue.sort((a, b) => a.localeCompare(b));
        }
      }
    }
  }

  // 10. Check Bats availability in closure
  const hasBatsInClosure = narrowedPackages.some(
    (pkgName) => descriptorMap.get(pkgName)?.hasBats === true,
  );

  // 11. Classify and rewrite configured validation commands
  const rewrittenCommands: ValidationCommand[] = [];
  for (const cmd of commands) {
    const classification = classifyCommand(cmd);
    if (!classification) {
      return fullPlan('unknown_command');
    }
    const rewritten = rewriteCommand(
      cmd,
      classification,
      seedPackage,
      narrowedPackages,
      descriptorMap,
      hasBatsInClosure,
    );
    if (rewritten !== null) {
      rewrittenCommands.push(rewritten);
    }
  }

  // 12. Classify and rewrite tiers if present
  let rewrittenTiers: string[][] | undefined;
  if (tiers) {
    rewrittenTiers = [];
    for (const tier of tiers) {
      const tierCommands: string[] = [];
      for (const cmd of tier) {
        const classification = classifyCommand(cmd);
        if (!classification) {
          return fullPlan('unknown_command');
        }
        const rewritten = rewriteCommand(
          cmd,
          classification,
          seedPackage,
          narrowedPackages,
          descriptorMap,
          hasBatsInClosure,
        );
        if (rewritten !== null) {
          if (Array.isArray(rewritten)) {
            tierCommands.push(rewritten.join(' '));
          } else {
            tierCommands.push(rewritten);
          }
        }
      }
      if (tierCommands.length > 0) {
        rewrittenTiers.push(tierCommands);
      }
    }
  }

  return {
    mode: 'narrow',
    changedPackage: seedPackage,
    narrowedPackages,
    commands: rewrittenCommands,
    ...(rewrittenTiers !== undefined ? { tiers: rewrittenTiers } : {}),
  };
}
