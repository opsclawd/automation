import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { ConfigError } from './errors.js';
import { orchestratorConfigSchema, type OrchestratorConfig } from './schema.js';

export type ConfigSourceKind = 'automation' | 'target' | 'local';

export interface ConfigSource {
  path: string;
  kind: ConfigSourceKind;
  present: boolean;
}

export interface LayeredConfigInput {
  automationRoot: string;
  targetRoot?: string;
}

export interface LoadedConfig {
  config: OrchestratorConfig;
  sources: ConfigSource[];
  fingerprint: string;
  rawMergedJson: unknown;
}

interface LayerMetadata {
  kind: ConfigSourceKind;
  isTarget: boolean;
}

export function loadLayeredConfig(input: LayeredConfigInput): LoadedConfig {
  const targetRoot = input.targetRoot ?? input.automationRoot;
  const hasTargetRoot = input.targetRoot !== undefined;
  const layers: Array<{
    path: string;
    kind: ConfigSourceKind;
    required: boolean;
    isTarget: boolean;
  }> = [
    {
      path: join(input.automationRoot, '.ai-orchestrator.json'),
      kind: 'automation',
      required: true,
      isTarget: false,
    },
    {
      path: join(input.automationRoot, '.ai-orchestrator.local.json'),
      kind: 'local',
      required: false,
      isTarget: false,
    },
    {
      path: join(targetRoot, '.ai-orchestrator.json'),
      kind: 'target',
      required: false,
      isTarget: true,
    },
    {
      path: join(targetRoot, '.ai-orchestrator.local.json'),
      kind: 'local',
      required: false,
      isTarget: true,
    },
  ];

  const sources: ConfigSource[] = [];
  let merged: unknown = {};

  for (const layer of layers) {
    const shouldSkipMerge = layer.isTarget && !hasTargetRoot;
    const file = shouldSkipMerge ? undefined : readIfExists(layer.path);
    sources.push({ path: layer.path, kind: layer.kind, present: file !== undefined });
    if (file === undefined) {
      if (layer.required) {
        throw new ConfigError(`Missing .ai-orchestrator.json at ${layer.path}`);
      }
      continue;
    }
    try {
      const parsed = JSON.parse(file);
      merged = mergeLayer(merged, parsed, { kind: layer.kind, isTarget: layer.isTarget });
    } catch (err) {
      throw new ConfigError(`Invalid JSON in ${layer.path}: ${(err as Error).message}`);
    }
  }

  try {
    const validated = orchestratorConfigSchema.parse(merged);
    warnOnRetiredArbiterPhaseKey(validated);
    const normalized = normalizeRoles(validated);
    const fingerprint = sha256OfCanonicalJson(normalized);

    return {
      config: normalized,
      sources,
      fingerprint,
      rawMergedJson: merged,
    };
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ConfigError(formatZodError(err), err);
    }
    throw err;
  }
}

function warnOnRetiredArbiterPhaseKey(config: OrchestratorConfig): void {
  const phaseProfiles = config.agent?.phaseProfiles;
  if (!phaseProfiles) return;
  if (!Object.hasOwn(phaseProfiles, 'arbitrate')) return;
  console.warn(
    "[ai-orchestrator] phaseProfiles['arbitrate'] is retired and ignored. " +
      "Use phaseProfiles['arbiter'] instead.",
  );
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Returns an array containing each unique element in the input, preserving
 * the index of the first occurrence (stable deduplication).
 */
function stableUnique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isStringArray(val: unknown): val is string[] {
  return Array.isArray(val) && val.every((item) => typeof item === 'string');
}

function is2DStringArray(val: unknown): val is string[][] {
  return (
    Array.isArray(val) &&
    val.every((tier) => Array.isArray(tier) && tier.every((item) => typeof item === 'string'))
  );
}

/**
 * Normalizes validation tiers against the effective command list.
 *
 * Tier coherence rules:
 * - Commands present in a tier but absent from effectiveCommands are dropped.
 * - Duplicate command entries across tiers are eliminated; the first occurrence wins.
 * - Empty tiers after filtering are omitted.
 * - Ungrouped effective commands are left out of tiers (ValidationAdapter appends them in a final tier).
 */
function normalizeTiers(tiers: string[][], effectiveCommands: string[]): string[][] | undefined {
  const commandSet = new Set(effectiveCommands);
  const seen = new Set<string>();
  const normalized: string[][] = [];

  for (const tier of tiers) {
    const cleanTier: string[] = [];
    for (const cmd of tier) {
      if (commandSet.has(cmd) && !seen.has(cmd)) {
        seen.add(cmd);
        cleanTier.push(cmd);
      }
    }
    if (cleanTier.length > 0) {
      normalized.push(cleanTier);
    }
  }

  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Merges validation configuration across layers with target-ownership semantics.
 *
 * Validation policy resolution rules:
 * 1. Target replacement: When a target layer (target base or target local) declares
 *    `validation.commands`, it completely replaces inherited commands rather than
 *    concatenating. This allows target repositories to define only the validation
 *    gates applicable to their codebase.
 * 2. Explicit additions: `validation.additionalCommands` allows a target or local layer
 *    to append commands to the inherited set without replacing the defaults.
 * 3. Stable deduplication: Commands are deduplicated by exact string equality in
 *    first-surviving order across both replacement and additions.
 * 4. Tier coherence & schedule clearing: ValidationAdapter executes all commands named
 *    in `validation.tiers` plus any ungrouped commands. If a target replaces commands,
 *    retaining inherited tiers would reintroduce removed commands at execution time.
 *    Therefore, target command replacement clears inherited tiers unless the target
 *    layer specifies its own `tiers`. When tiers are provided, they replace inherited
 *    tiers as a unit and are normalized against effective commands (dropping absent
 *    commands, cross-tier duplicates, and empty tiers). Additions-only targets retain
 *    inherited tiers.
 */
function mergeValidationPolicy(
  baseValidation: unknown,
  overrideValidation: unknown,
  layer: LayerMetadata,
): unknown {
  if (!isPlainObject(overrideValidation)) {
    return isPlainObject(baseValidation) ? baseValidation : overrideValidation;
  }

  const baseValObj = isPlainObject(baseValidation) ? baseValidation : {};
  const baseCommands = baseValObj.commands;
  const baseTiers = baseValObj.tiers;

  const overrideCommands = overrideValidation.commands;
  const overrideAdditions = overrideValidation.additionalCommands;
  const overrideTiers = overrideValidation.tiers;

  let resolvedCommands: unknown;
  let resolvedTiers: unknown;

  // Resolve commands and additions
  if (layer.isTarget) {
    if (overrideCommands !== undefined) {
      if (isStringArray(overrideCommands)) {
        const additions = isStringArray(overrideAdditions) ? overrideAdditions : [];
        resolvedCommands = stableUnique([...overrideCommands, ...additions]);
      } else {
        resolvedCommands = overrideCommands;
      }
      // Target replacement clears inherited tiers unless target explicitly declares tiers
      if (overrideTiers !== undefined) {
        resolvedTiers = overrideTiers;
      } else {
        resolvedTiers = undefined;
      }
    } else {
      // Target omits commands: inherit existing commands and append additions if present
      if (isStringArray(overrideAdditions)) {
        const baseCmds = isStringArray(baseCommands) ? baseCommands : [];
        resolvedCommands = stableUnique([...baseCmds, ...overrideAdditions]);
      } else {
        resolvedCommands = baseCommands;
      }
      // Inherited tiers are retained when commands are not replaced
      if (overrideTiers !== undefined) {
        resolvedTiers = overrideTiers;
      } else {
        resolvedTiers = baseTiers;
      }
    }
  } else {
    // Automation layer (base or local)
    if (overrideCommands !== undefined) {
      if (isStringArray(overrideCommands)) {
        const baseCmds = isStringArray(baseCommands) ? baseCommands : [];
        const additions = isStringArray(overrideAdditions) ? overrideAdditions : [];
        resolvedCommands = stableUnique([...baseCmds, ...overrideCommands, ...additions]);
      } else {
        resolvedCommands = overrideCommands;
      }
    } else {
      if (isStringArray(overrideAdditions)) {
        const baseCmds = isStringArray(baseCommands) ? baseCommands : [];
        resolvedCommands = stableUnique([...baseCmds, ...overrideAdditions]);
      } else {
        resolvedCommands = baseCommands;
      }
    }
    if (overrideTiers !== undefined) {
      resolvedTiers = overrideTiers;
    } else {
      resolvedTiers = baseTiers;
    }
  }

  // Normalize tiers against effective commands if valid string arrays
  if (
    resolvedTiers !== undefined &&
    is2DStringArray(resolvedTiers) &&
    isStringArray(resolvedCommands)
  ) {
    resolvedTiers = normalizeTiers(resolvedTiers, resolvedCommands);
  }

  // Build merged validation object
  const outValidation: Record<string, unknown> = {};

  // Generic merge non-policy validation properties (e.g. timeout, narrowByChangedFiles)
  for (const [k, v] of Object.entries(baseValObj)) {
    if (k !== 'commands' && k !== 'additionalCommands' && k !== 'tiers') {
      outValidation[k] = v;
    }
  }
  for (const [k, v] of Object.entries(overrideValidation)) {
    if (k !== 'commands' && k !== 'additionalCommands' && k !== 'tiers') {
      outValidation[k] = genericMerge(outValidation[k], v);
    }
  }

  if (overrideValidation.additionalCommands !== undefined) {
    outValidation.additionalCommands = overrideValidation.additionalCommands;
  } else if (baseValObj.additionalCommands !== undefined) {
    outValidation.additionalCommands = baseValObj.additionalCommands;
  }

  if (resolvedCommands !== undefined) {
    outValidation.commands = resolvedCommands;
  }
  if (resolvedTiers !== undefined) {
    outValidation.tiers = resolvedTiers;
  } else {
    delete outValidation.tiers;
  }

  return outValidation;
}

/**
 * Generic deep-merge for general configuration.
 * Arrays other than validation commands/tiers preserve jq * index-by-index merge semantics.
 * phaseProfiles and phaseRoutes replace object properties.
 */
function genericMerge(base: unknown, override: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(override)) {
    const out = [...base];
    for (let i = 0; i < override.length; i++) {
      out[i] = genericMerge(base[i], override[i]);
    }
    return out;
  }
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out: Record<string, unknown> = { ...base };
  for (const [k, value] of Object.entries(override)) {
    if (k === 'phaseProfiles' || k === 'phaseRoutes') {
      out[k] = {
        ...(isPlainObject(base[k]) ? (base[k] as Record<string, unknown>) : {}),
        ...(isPlainObject(value) ? (value as Record<string, unknown>) : {}),
      };
      continue;
    }
    out[k] = genericMerge(base[k], value);
  }
  return out;
}

/**
 * Merges a layer override into the accumulated base configuration.
 * Validation policy is resolved narrowly with layer metadata.
 */
function mergeLayer(base: unknown, override: unknown, layer: LayerMetadata): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out: Record<string, unknown> = { ...base };
  for (const [k, value] of Object.entries(override)) {
    if (k === 'validation') {
      out.validation = mergeValidationPolicy(base.validation, value, layer);
    } else if (k === 'phaseProfiles' || k === 'phaseRoutes') {
      out[k] = {
        ...(isPlainObject(base[k]) ? (base[k] as Record<string, unknown>) : {}),
        ...(isPlainObject(value) ? (value as Record<string, unknown>) : {}),
      };
    } else {
      out[k] = genericMerge(base[k], value);
    }
  }
  return out;
}

export function sha256OfCanonicalJson(value: unknown): string {
  const canonical = canonicalize(value);
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

function normalizeRoles(config: OrchestratorConfig): OrchestratorConfig {
  const agent = config.agent;
  if (!agent?.roles) return config;
  const { roles, phaseProfiles } = agent;
  for (const entry of Object.values(phaseProfiles)) {
    if (entry.role) {
      const role = roles[entry.role];
      if (role && !entry.profile) {
        entry.profile = role.profile;
      }
      if (role && !entry.fallbackProfile && !entry.fallbackRole && role.fallback) {
        entry.fallbackProfile = role.fallback;
      }
    }
    if (entry.fallbackRole) {
      const fbRole = roles[entry.fallbackRole];
      if (fbRole && !entry.fallbackProfile) {
        entry.fallbackProfile = fbRole.profile;
      }
    }
  }
  return config;
}

export function loadConfig(repoRoot: string): OrchestratorConfig {
  return loadLayeredConfig({ automationRoot: repoRoot }).config;
}
