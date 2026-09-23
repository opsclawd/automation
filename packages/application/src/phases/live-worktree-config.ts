import { mergeConfigLayers, type ConfigSourceKind } from '@ai-sdlc/shared';
import type { ReadWorktreeFilePort } from '../ports/read-worktree-file-port.js';

export const WORKTREE_ORCHESTRATOR_CONFIG_PATH = '.ai-orchestrator.json';
export const WORKTREE_ORCHESTRATOR_LOCAL_CONFIG_PATH = '.ai-orchestrator.local.json';

export type LiveWorktreeConfigStatus =
  | 'present'
  | 'missing'
  | 'malformed'
  | 'reader_unavailable'
  | 'error';

export interface LiveConfigLayerInspection {
  label: string;
  path: string;
  root: string;
  relativePath: string;
  kind: ConfigSourceKind;
  isTarget: boolean;
  required?: boolean;
  status: LiveWorktreeConfigStatus;
  raw?: string | undefined;
  parsed?: unknown;
  sanitized?: Record<string, unknown> | undefined;
  error?: string | undefined;
}

export interface LiveWorktreeConfigInspection {
  path: string;
  status: LiveWorktreeConfigStatus;
  layers: LiveConfigLayerInspection[];
  effectiveConfig?: Record<string, unknown> | undefined;
  effectiveCommands?: string[] | undefined;
  raw?: string | undefined;
  error?: string | undefined;
}

export interface LiveWorktreeConfigOptions {
  cwd: string;
  readWorktreeFile?: ReadWorktreeFilePort | undefined;
  automationRoot?: string | undefined;
  targetRoot?: string | undefined;
}

/**
 * Allowlist filter for review-relevant configuration fields.
 * Explicitly strips sensitive/operator fields (such as notifications.runWebhookUrl, agent secrets, tokens)
 * while preserving validation commands, tiers, timeouts, and execution policy.
 */
export function sanitizeConfigForReview(config: unknown): Record<string, unknown> {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return {};
  }
  const rawObj = config as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  if (typeof rawObj.executionPolicy === 'string') {
    sanitized.executionPolicy = rawObj.executionPolicy;
  }

  if (
    typeof rawObj.validation === 'object' &&
    rawObj.validation !== null &&
    !Array.isArray(rawObj.validation)
  ) {
    const rawVal = rawObj.validation as Record<string, unknown>;
    const valSanitized: Record<string, unknown> = {};

    if (Array.isArray(rawVal.commands)) {
      valSanitized.commands = rawVal.commands.filter((c) => typeof c === 'string');
    }
    if (Array.isArray(rawVal.additionalCommands)) {
      valSanitized.additionalCommands = rawVal.additionalCommands.filter(
        (c) => typeof c === 'string',
      );
    }
    if (Array.isArray(rawVal.selfVerifyCommands)) {
      valSanitized.selfVerifyCommands = rawVal.selfVerifyCommands.filter(
        (c) => typeof c === 'string',
      );
    }
    if (Array.isArray(rawVal.tiers)) {
      valSanitized.tiers = rawVal.tiers;
    }
    if (typeof rawVal.timeout === 'number') {
      valSanitized.timeout = rawVal.timeout;
    }
    if (typeof rawVal.narrowByChangedFiles === 'boolean') {
      valSanitized.narrowByChangedFiles = rawVal.narrowByChangedFiles;
    }
    if (Array.isArray(rawVal.forbiddenArtifactPaths)) {
      valSanitized.forbiddenArtifactPaths = rawVal.forbiddenArtifactPaths;
    }
    if (typeof rawVal.commandScopes === 'object' && rawVal.commandScopes !== null) {
      valSanitized.commandScopes = rawVal.commandScopes;
    }

    sanitized.validation = valSanitized;
  }

  if (
    typeof rawObj.governance === 'object' &&
    rawObj.governance !== null &&
    !Array.isArray(rawObj.governance)
  ) {
    const rawGov = rawObj.governance as Record<string, unknown>;
    if (Array.isArray(rawGov.protectedPaths)) {
      sanitized.governance = { protectedPaths: rawGov.protectedPaths };
    }
  }

  return sanitized;
}

export async function inspectLiveWorktreeConfiguration(
  ctx: LiveWorktreeConfigOptions,
): Promise<LiveWorktreeConfigInspection> {
  if (!ctx.readWorktreeFile) {
    return {
      path: WORKTREE_ORCHESTRATOR_CONFIG_PATH,
      status: 'reader_unavailable',
      layers: [],
    };
  }

  const liveWorktreeRoot = ctx.cwd;
  const automationRoot = ctx.automationRoot;
  const targetRoot = ctx.targetRoot;

  const hasDistinctRoots =
    automationRoot !== undefined && targetRoot !== undefined
      ? automationRoot !== targetRoot
      : automationRoot !== undefined && automationRoot !== liveWorktreeRoot;

  const layerDefinitions: Array<{
    label: string;
    root: string;
    relativePath: string;
    kind: ConfigSourceKind;
    isTarget: boolean;
    required: boolean;
  }> = hasDistinctRoots
    ? [
        {
          label: 'Automation Base',
          root: automationRoot!,
          relativePath: WORKTREE_ORCHESTRATOR_CONFIG_PATH,
          kind: 'automation',
          isTarget: false,
          required: true,
        },
        {
          label: 'Automation Local',
          root: automationRoot!,
          relativePath: WORKTREE_ORCHESTRATOR_LOCAL_CONFIG_PATH,
          kind: 'local',
          isTarget: false,
          required: false,
        },
        {
          label: 'Target Base',
          root: liveWorktreeRoot,
          relativePath: WORKTREE_ORCHESTRATOR_CONFIG_PATH,
          kind: 'target',
          isTarget: true,
          required: false,
        },
        {
          label: 'Target Local',
          root: liveWorktreeRoot,
          relativePath: WORKTREE_ORCHESTRATOR_LOCAL_CONFIG_PATH,
          kind: 'local',
          isTarget: true,
          required: false,
        },
      ]
    : [
        {
          label: 'Base Configuration',
          root: liveWorktreeRoot,
          relativePath: WORKTREE_ORCHESTRATOR_CONFIG_PATH,
          kind: 'automation',
          isTarget: false,
          required: true,
        },
        {
          label: 'Local Configuration',
          root: liveWorktreeRoot,
          relativePath: WORKTREE_ORCHESTRATOR_LOCAL_CONFIG_PATH,
          kind: 'local',
          isTarget: false,
          required: false,
        },
      ];

  const layerInspections: LiveConfigLayerInspection[] = [];

  for (const def of layerDefinitions) {
    const fullDisplayPath = `${def.root}/${def.relativePath}`;
    try {
      const raw = await ctx.readWorktreeFile(def.root, def.relativePath);
      if (raw === undefined || raw === null) {
        layerInspections.push({
          label: def.label,
          path: fullDisplayPath,
          root: def.root,
          relativePath: def.relativePath,
          kind: def.kind,
          isTarget: def.isTarget,
          required: def.required,
          status: 'missing',
        });
        continue;
      }

      try {
        const parsed = JSON.parse(raw);
        layerInspections.push({
          label: def.label,
          path: fullDisplayPath,
          root: def.root,
          relativePath: def.relativePath,
          kind: def.kind,
          isTarget: def.isTarget,
          required: def.required,
          status: 'present',
          raw,
          parsed,
          sanitized: sanitizeConfigForReview(parsed),
        });
      } catch (parseErr) {
        layerInspections.push({
          label: def.label,
          path: fullDisplayPath,
          root: def.root,
          relativePath: def.relativePath,
          kind: def.kind,
          isTarget: def.isTarget,
          required: def.required,
          status: 'malformed',
          raw,
          error: parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
      }
    } catch (err) {
      layerInspections.push({
        label: def.label,
        path: fullDisplayPath,
        root: def.root,
        relativePath: def.relativePath,
        kind: def.kind,
        isTarget: def.isTarget,
        required: def.required,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Check for malformed or error
  const malformedLayer = layerInspections.find((l) => l.status === 'malformed');
  if (malformedLayer) {
    return {
      path: malformedLayer.relativePath,
      status: 'malformed',
      layers: layerInspections,
      raw: malformedLayer.raw,
      error: malformedLayer.error,
    };
  }

  const errorLayer = layerInspections.find((l) => l.status === 'error');
  if (errorLayer) {
    return {
      path: errorLayer.relativePath,
      status: 'error',
      layers: layerInspections,
      error: errorLayer.error,
    };
  }

  const missingRequiredLayer = layerInspections.find((l) => l.required && l.status === 'missing');
  if (missingRequiredLayer) {
    return {
      path: missingRequiredLayer.relativePath,
      status: 'missing',
      layers: layerInspections,
      error: `Missing required configuration layer at ${missingRequiredLayer.path}`,
    };
  }

  const presentLayers = layerInspections.filter((l) => l.status === 'present');
  if (presentLayers.length === 0) {
    return {
      path: WORKTREE_ORCHESTRATOR_CONFIG_PATH,
      status: 'missing',
      layers: layerInspections,
    };
  }

  // Merge present layers in precedence order
  const rawMerged = mergeConfigLayers(
    presentLayers.map((l) => ({ parsed: l.parsed, kind: l.kind, isTarget: l.isTarget })),
  );
  const effectiveConfig = sanitizeConfigForReview(rawMerged);
  const validationObj =
    typeof effectiveConfig.validation === 'object' &&
    effectiveConfig.validation !== null &&
    !Array.isArray(effectiveConfig.validation)
      ? (effectiveConfig.validation as Record<string, unknown>)
      : undefined;
  const effectiveCommands = Array.isArray(validationObj?.commands)
    ? (validationObj.commands as string[])
    : [];

  const primaryTargetLayer =
    layerInspections.find(
      (l) =>
        l.isTarget &&
        l.relativePath === WORKTREE_ORCHESTRATOR_CONFIG_PATH &&
        l.status === 'present',
    ) ?? presentLayers[0];

  return {
    path: WORKTREE_ORCHESTRATOR_CONFIG_PATH,
    status: 'present',
    layers: layerInspections,
    effectiveConfig,
    effectiveCommands,
    raw: primaryTargetLayer?.raw,
  };
}

export function formatLiveWorktreeConfigurationForPrompt(
  inspection: LiveWorktreeConfigInspection,
): string {
  switch (inspection.status) {
    case 'present': {
      const lines: string[] = [
        `File: ${inspection.path}`,
        'Status: present',
        '',
        '### Effective Validation Configuration (Resolved across live layers)',
        '```json',
        JSON.stringify(inspection.effectiveConfig ?? {}, null, 2),
        '```',
        '',
        '### Live Configuration Layers (Precedence order: automation -> automation-local -> target -> target-local)',
      ];
      for (const layer of inspection.layers) {
        lines.push(`- Layer: ${layer.label}`);
        lines.push(`  Path: ${layer.path}`);
        lines.push(`  Kind: ${layer.kind}`);
        lines.push(`  Status: ${layer.status}`);
        if (layer.status === 'present' && layer.sanitized) {
          lines.push('  Configuration:');
          lines.push('  ```json');
          lines.push('  ' + JSON.stringify(layer.sanitized, null, 2).replace(/\n/g, '\n  '));
          lines.push('  ```');
        } else if (layer.error) {
          lines.push(`  Error: ${layer.error}`);
        }
      }
      return lines.join('\n');
    }

    case 'missing':
      return [
        `File: ${inspection.path}`,
        `Status: NOT PRESENT in active worktree (\`${inspection.path}\`).`,
      ].join('\n');

    case 'malformed':
      return [
        `File: ${inspection.path}`,
        `Status: MALFORMED JSON (parse error: ${inspection.error ?? 'unknown error'})`,
        '',
        '```',
        inspection.raw?.trim() ?? '',
        '```',
      ].join('\n');

    case 'reader_unavailable':
      return [
        `File: ${inspection.path}`,
        'Status: UNAVAILABLE (worktree file reader not available in execution context).',
      ].join('\n');

    case 'error':
      return [
        `File: ${inspection.path}`,
        `Status: ERROR reading file (${inspection.error ?? 'unknown error'}).`,
      ].join('\n');
  }
}

export async function loadLiveWorktreeConfiguration(
  ctx: LiveWorktreeConfigOptions,
): Promise<string> {
  const inspection = await inspectLiveWorktreeConfiguration(ctx);
  return formatLiveWorktreeConfigurationForPrompt(inspection);
}
