import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { ConfigError } from './errors.js';
import { orchestratorConfigSchema, type OrchestratorConfig } from './schema.js';

const CONFIG_FILENAME = '.ai-orchestrator.json';
const LOCAL_CONFIG_FILENAME = '.ai-orchestrator.local.json';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      result[key] = deepMerge(
        (base as Record<string, unknown>)[key],
        (override as Record<string, unknown>)[key],
      );
    }
    return result;
  }
  return override;
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
  if (existsSync(resolve(repoRoot, LOCAL_CONFIG_FILENAME))) {
    let localRaw: string;
    try {
      localRaw = readFileSync(resolve(repoRoot, LOCAL_CONFIG_FILENAME), 'utf8');
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
  }
  const parsed = orchestratorConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(formatZodError(parsed.error), parsed.error);
  }
  return parsed.data;
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
