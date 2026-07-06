import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
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
      merged = deepMergeWithPhaseProfilesReplace(merged, parsed);
    } catch (err) {
      throw new ConfigError(`Invalid JSON in ${layer.path}: ${(err as Error).message}`);
    }
  }

  const validated = orchestratorConfigSchema.parse(merged);
  const normalized = normalizeRoles(validated);
  const fingerprint = sha256OfCanonicalJson(normalized);

  return {
    config: normalized,
    sources,
    fingerprint,
    rawMergedJson: merged,
  };
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function deepMergeWithPhaseProfilesReplace(
  base: unknown,
  override: unknown,
  key?: string,
): unknown {
  if (Array.isArray(base) && Array.isArray(override)) {
    if (key === 'commands') {
      return [...base, ...override];
    }
    const out = [...base];
    for (let i = 0; i < override.length; i++) {
      out[i] = deepMergeWithPhaseProfilesReplace(base[i], override[i]);
    }
    return out;
  }
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out: Record<string, unknown> = { ...base };
  for (const [k, value] of Object.entries(override)) {
    if (k === 'phaseProfiles' || k === 'phaseRoutes') {
      out[k] = value;
      continue;
    }
    out[k] = deepMergeWithPhaseProfilesReplace(base[k], value, k);
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

const CONFIG_FILENAME = '.ai-orchestrator.json';
const LOCAL_CONFIG_FILENAME = '.ai-orchestrator.local.json';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      if (key === '__proto__') {
        continue;
      }
      result[key] = deepMerge(
        (base as Record<string, unknown>)[key],
        (override as Record<string, unknown>)[key],
      );
    }
    return result;
  }
  return override;
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
  const path = resolve(repoRoot, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message =
      code === 'ENOENT'
        ? `Missing ${CONFIG_FILENAME} at ${path}`
        : `Failed to read ${CONFIG_FILENAME} at ${path}: ${(err as Error).message}`;
    throw new ConfigError(message, err);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${CONFIG_FILENAME}: ${(err as Error).message}`, err);
  }
  const localPath = resolve(repoRoot, LOCAL_CONFIG_FILENAME);
  const hasLocal = existsSync(localPath);
  if (hasLocal) {
    let localRaw: string;
    try {
      localRaw = readFileSync(localPath, 'utf8');
    } catch (err) {
      throw new ConfigError(
        `Failed to read ${LOCAL_CONFIG_FILENAME}: ${(err as Error).message}`,
        err,
      );
    }
    let localJson: unknown;
    try {
      localJson = JSON.parse(localRaw);
    } catch (err) {
      throw new ConfigError(
        `Invalid JSON in ${LOCAL_CONFIG_FILENAME}: ${(err as Error).message}`,
        err,
      );
    }
    json = deepMerge(json, localJson);
    // phaseProfiles entries must be replaced wholesale, not deep-merged key-by-key.
    // deepMerge accumulates keys from both sides, so base {profile, fallbackProfile} + local
    // {role} produces all three keys and fails schema validation. Re-stamp any phase the local
    // config defines so the local entry wins entirely, regardless of which keys it uses.
    if (isPlainObject(json) && isPlainObject(localJson)) {
      const localAgent = (localJson as Record<string, unknown>).agent;
      if (isPlainObject(localAgent)) {
        const localPhaseProfiles = (localAgent as Record<string, unknown>).phaseProfiles;
        if (isPlainObject(localPhaseProfiles)) {
          const mergedAgent = (json as Record<string, unknown>).agent as Record<string, unknown>;
          const mergedPhaseProfiles = mergedAgent.phaseProfiles as Record<string, unknown>;
          for (const [phase, localEntry] of Object.entries(localPhaseProfiles)) {
            mergedPhaseProfiles[phase] = localEntry;
          }
        }
      }
    }
  }
  const parsed = orchestratorConfigSchema.safeParse(json);
  if (!parsed.success) {
    const extraMsg = hasLocal ? ` (validated with overrides from ${LOCAL_CONFIG_FILENAME})` : '';
    throw new ConfigError(`${formatZodError(parsed.error)}${extraMsg}`, parsed.error);
  }
  return normalizeRoles(parsed.data);
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
