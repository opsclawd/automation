import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { ConfigError } from './errors.js';
import { orchestratorConfigSchema, type OrchestratorConfig } from './schema.js';

const CONFIG_FILENAME = '.ai-orchestrator.json';

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
