import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { ConfigError } from './errors.js';
import { orchestratorConfigSchema, type OrchestratorConfig } from './schema.js';

const CONFIG_FILENAME = '.ai-orchestrator.json';
const PROFILE_ENV = 'AI_ORCHESTRATOR_PROFILE';
const PHASE_ENV_PREFIX = 'AI_ORCHESTRATOR_PHASE_';

type Env = Record<string, string | undefined>;

export function loadConfig(repoRoot: string, env: Env = process.env): OrchestratorConfig {
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
  const withOverrides = applyEnvOverrides(json, env);
  const parsed = orchestratorConfigSchema.safeParse(withOverrides);
  if (!parsed.success) {
    throw new ConfigError(formatZodError(parsed.error), parsed.error);
  }
  return parsed.data;
}

function applyEnvOverrides(json: unknown, env: Env): unknown {
  const profileOverride = env[PROFILE_ENV]?.trim();
  const phaseOverrides = collectPhaseOverrides(env);
  if (!profileOverride && phaseOverrides.size === 0) return json;

  if (!isObject(json) || !isObject(json.agent)) {
    throw new ConfigError(
      `Cannot apply env overrides (${PROFILE_ENV} or ${PHASE_ENV_PREFIX}*): config has no 'agent' block`,
    );
  }
  const agent = { ...json.agent };

  if (profileOverride) {
    agent.defaultProfile = profileOverride;
  }

  if (phaseOverrides.size > 0) {
    if (!isObject(agent.phaseProfiles)) {
      throw new ConfigError(
        `Cannot apply ${PHASE_ENV_PREFIX}* overrides: config has no 'agent.phaseProfiles' block`,
      );
    }
    const phaseProfiles = { ...agent.phaseProfiles };
    const phaseKeyByNorm = new Map(
      Object.keys(phaseProfiles).map((k) => [normalizePhase(k), k] as const),
    );
    for (const [norm, profile] of phaseOverrides) {
      const key = phaseKeyByNorm.get(norm);
      if (!key) {
        throw new ConfigError(
          `${PHASE_ENV_PREFIX}${norm} does not match any phase in agent.phaseProfiles (known: ${[...phaseKeyByNorm.values()].join(', ') || '<none>'})`,
        );
      }
      const existing = isObject(phaseProfiles[key]) ? phaseProfiles[key] : {};
      phaseProfiles[key] = { ...existing, profile };
    }
    agent.phaseProfiles = phaseProfiles;
  }

  return { ...json, agent };
}

function collectPhaseOverrides(env: Env): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(PHASE_ENV_PREFIX) || v === undefined) continue;
    const profile = v.trim();
    if (!profile) continue;
    out.set(k.slice(PHASE_ENV_PREFIX.length), profile);
  }
  return out;
}

function normalizePhase(name: string): string {
  return name.replaceAll('-', '_').toUpperCase();
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
