import { describe, it, expect } from 'vitest';
import type { AgentConfig } from '../schema.js';
import {
  PINNED_RUNTIME_NAMES,
  PHASE_ROLE_NAMES,
  DEFAULT_PINNED_RUNTIME_PROFILES,
  DEFAULT_PHASE_ROLE_MAPPING,
  PinnedRuntimeResolutionError,
  resolvePinnedProfile,
  resolvePinnedProfileForPhase,
  type PhaseRoleName,
} from '../pinned-runtime.js';

function createMockConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    defaultProfile: 'builder',
    profiles: {
      // claude-code
      claude: {
        runtime: 'claude-code',
        provider: 'anthropic',
        model: 'opus',
        timeoutMinutes: 30,
      },
      'claude-sonnet': {
        runtime: 'claude-code',
        provider: 'anthropic',
        model: 'sonnet',
        timeoutMinutes: 30,
      },
      'claude-haiku': {
        runtime: 'claude-code',
        provider: 'anthropic',
        model: 'haiku',
        timeoutMinutes: 30,
      },
      // antigravity
      gemini: {
        runtime: 'antigravity',
        provider: 'google',
        model: 'gemini-3.5-flash-high',
        timeoutMinutes: 30,
      },
      reviewer: {
        runtime: 'antigravity',
        provider: 'google',
        model: 'gemini-3.5-flash-high',
        timeoutMinutes: 30,
      },
      'task-reviewer': {
        runtime: 'antigravity',
        provider: 'google',
        model: 'gemini-3.5-flash-low',
        timeoutMinutes: 30,
      },
      // codex
      'codex-reviewer': {
        runtime: 'codex',
        provider: 'openai',
        model: 'default',
        timeoutMinutes: 45,
      },
      'codex-writer': {
        runtime: 'codex',
        provider: 'openai',
        model: 'default',
        timeoutMinutes: 45,
      },
      // opencode
      architect: {
        runtime: 'opencode',
        provider: 'zai-coding-plan',
        model: 'glm-5.1',
        timeoutMinutes: 30,
      },
      senior: {
        runtime: 'opencode',
        provider: 'ollama-cloud',
        model: 'glm-5.1',
        timeoutMinutes: 30,
      },
      builder: {
        runtime: 'opencode',
        provider: 'minimax-coding-plan',
        model: 'MiniMax-M2.7',
        timeoutMinutes: 30,
      },
      junior: {
        runtime: 'opencode',
        provider: 'opencode',
        model: 'deepseek-v4-flash-free',
        timeoutMinutes: 30,
      },
      qwen: {
        runtime: 'opencode',
        provider: 'crofai',
        model: 'qwen3.6-27b',
        timeoutMinutes: 30,
      },
    },
    roles: {
      planner: { profile: 'architect' },
      implementer: { profile: 'qwen' },
      fixer: { profile: 'builder' },
      critic: { profile: 'task-reviewer' },
      'task-agent': { profile: 'junior' },
      'pr-reviewer': { profile: 'gemini' },
    },
    phaseProfiles: {
      'plan-design': { role: 'planner' },
      'architecture-review': { role: 'pr-reviewer' },
      'architecture-fix': { role: 'planner' },
      implement: { role: 'implementer' },
      'quality-review': { role: 'critic' },
      'spec-review': { role: 'critic' },
      'follow-up-review': { role: 'critic' },
      'fix-review': { role: 'fixer' },
      'fix-validate': { role: 'fixer' },
      compound: { role: 'task-agent' },
      'create-pr': { role: 'task-agent' },
      'result-writer': { role: 'critic' },
    },
    ...overrides,
  };
}

describe('pinned-runtime defaults & mapping', () => {
  it('covers all 4 known runtimes', () => {
    expect(PINNED_RUNTIME_NAMES).toEqual(['claude-code', 'antigravity', 'codex', 'opencode']);
  });

  it('covers all 6 phase roles', () => {
    expect(PHASE_ROLE_NAMES).toEqual([
      'planner',
      'implementer',
      'fixer',
      'critic',
      'pr-reviewer',
      'task-agent',
    ]);
  });

  it('DEFAULT_PINNED_RUNTIME_PROFILES provides complete 4x6 matrix', () => {
    for (const runtime of PINNED_RUNTIME_NAMES) {
      const roleMap = DEFAULT_PINNED_RUNTIME_PROFILES[runtime];
      expect(roleMap, `Runtime '${runtime}' must have a role map`).toBeDefined();
      for (const role of PHASE_ROLE_NAMES) {
        expect(
          roleMap[role],
          `Runtime '${runtime}' role '${role}' must map to a profile`,
        ).toBeDefined();
        expect(typeof roleMap[role]).toBe('string');
        expect(roleMap[role].length).toBeGreaterThan(0);
      }
    }
  });

  it('DEFAULT_PHASE_ROLE_MAPPING maps all pipeline phases to canonical roles', () => {
    const expectedPhases = [
      'plan-design',
      'architecture-review',
      'architecture-fix',
      'implement',
      'quality-review',
      'spec-review',
      'post-implementation-spec-review',
      'post-implementation-quality-review',
      'follow-up-review',
      'fix-review',
      'fix-validate',
      'whole-pr-fix-review',
      'compound',
      'create-pr',
      'result-writer',
    ];

    for (const phase of expectedPhases) {
      const role = DEFAULT_PHASE_ROLE_MAPPING[phase];
      expect(role, `Phase '${phase}' must map to a defined PhaseRoleName`).toBeDefined();
      expect(PHASE_ROLE_NAMES.includes(role)).toBe(true);
    }
  });
});

describe('resolvePinnedProfile', () => {
  const config = createMockConfig();

  it('resolves all 4 runtimes across all 6 roles against base config', () => {
    for (const runtime of PINNED_RUNTIME_NAMES) {
      for (const role of PHASE_ROLE_NAMES) {
        const resolved = resolvePinnedProfile({
          pinnedRuntime: runtime,
          role,
          config,
        });
        expect(resolved).toBeDefined();
        // Verify resolved profile exists and matches runtime
        const profile = config.profiles[resolved];
        expect(profile).toBeDefined();
        expect(profile.runtime).toBe(runtime);
      }
    }
  });

  it('gives precedence to repo pinnedRuntimeProfiles override', () => {
    const customConfig = createMockConfig({
      pinnedRuntimeProfiles: {
        opencode: {
          planner: 'senior', // override default 'architect'
        },
      },
    });

    const resolved = resolvePinnedProfile({
      pinnedRuntime: 'opencode',
      role: 'planner',
      config: customConfig,
    });
    expect(resolved).toBe('senior');
  });

  it('falls back to "claude" if claude-sonnet/claude-haiku are missing but "claude" exists', () => {
    const minimalClaudeConfig = createMockConfig({
      profiles: {
        claude: {
          runtime: 'claude-code',
          provider: 'anthropic',
          model: 'opus',
          timeoutMinutes: 30,
        },
      },
    });

    const resolved = resolvePinnedProfile({
      pinnedRuntime: 'claude-code',
      role: 'implementer',
      config: minimalClaudeConfig,
    });
    expect(resolved).toBe('claude');
  });

  it('fails loudly when role is unmapped for runtime', () => {
    expect(() => {
      resolvePinnedProfile({
        pinnedRuntime: 'codex',
        role: 'non-existent-role' as PhaseRoleName,
        config,
      });
    }).toThrow(PinnedRuntimeResolutionError);

    expect(() => {
      resolvePinnedProfile({
        pinnedRuntime: 'codex',
        role: 'non-existent-role' as PhaseRoleName,
        config,
      });
    }).toThrow(/no mapped profile for role 'non-existent-role'/);
  });

  it('fails loudly when resolved profile is missing from agent.profiles', () => {
    const brokenConfig = createMockConfig({
      pinnedRuntimeProfiles: {
        codex: {
          planner: 'ghost-profile',
        },
      },
    });

    expect(() => {
      resolvePinnedProfile({
        pinnedRuntime: 'codex',
        role: 'planner',
        config: brokenConfig,
      });
    }).toThrow(/profile 'ghost-profile' is not defined in agent\.profiles/);
  });

  it('fails loudly when resolved profile has runtime mismatch', () => {
    const mismatchedConfig = createMockConfig({
      pinnedRuntimeProfiles: {
        codex: {
          planner: 'architect', // architect has runtime 'opencode', not 'codex'
        },
      },
    });

    expect(() => {
      resolvePinnedProfile({
        pinnedRuntime: 'codex',
        role: 'planner',
        config: mismatchedConfig,
      });
    }).toThrow(/profile 'architect', but that profile has runtime 'opencode'/);
  });
});

describe('resolvePinnedProfileForPhase', () => {
  const config = createMockConfig();

  it('resolves standard phases for pinned runtime', () => {
    expect(
      resolvePinnedProfileForPhase({
        pinnedRuntime: 'opencode',
        phaseName: 'plan-design',
        config,
      }),
    ).toBe('architect');

    expect(
      resolvePinnedProfileForPhase({
        pinnedRuntime: 'antigravity',
        phaseName: 'architecture-review',
        config,
      }),
    ).toBe('reviewer');

    expect(
      resolvePinnedProfileForPhase({
        pinnedRuntime: 'codex',
        phaseName: 'implement',
        config,
      }),
    ).toBe('codex-writer');

    expect(
      resolvePinnedProfileForPhase({
        pinnedRuntime: 'claude-code',
        phaseName: 'quality-review',
        config,
      }),
    ).toBe('claude-sonnet');
  });

  it('resolves legacy alias phases', () => {
    const resolved = resolvePinnedProfileForPhase({
      pinnedRuntime: 'codex',
      phaseName: 'post-implementation-quality-review',
      config,
    });
    expect(resolved).toBe('codex-reviewer');

    const resolvedFallback = resolvePinnedProfileForPhase({
      pinnedRuntime: 'opencode',
      phaseName: 'whole-pr-fix-review',
      config,
    });
    expect(resolvedFallback).toBe('builder');
  });

  it('fails loudly for unknown phase without role', () => {
    expect(() => {
      resolvePinnedProfileForPhase({
        pinnedRuntime: 'opencode',
        phaseName: 'unknown-mystery-phase',
        config,
      });
    }).toThrow(PinnedRuntimeResolutionError);

    expect(() => {
      resolvePinnedProfileForPhase({
        pinnedRuntime: 'opencode',
        phaseName: 'unknown-mystery-phase',
        config,
      });
    }).toThrow(/cannot resolve phase 'unknown-mystery-phase'/);
  });
});

describe('real committed .ai-orchestrator.json resolution', () => {
  it('resolves all 4 runtimes across all standard phases with zero gaps', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const rootJsonPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      '..',
      '.ai-orchestrator.json',
    );
    const parsed = JSON.parse(readFileSync(rootJsonPath, 'utf8'));
    const realAgentConfig = parsed.agent as AgentConfig;

    const standardPhases = [
      'plan-design',
      'architecture-review',
      'architecture-fix',
      'implement',
      'quality-review',
      'spec-review',
      'follow-up-review',
      'fix-review',
      'fix-validate',
      'compound',
      'create-pr',
      'result-writer',
    ];

    for (const runtime of PINNED_RUNTIME_NAMES) {
      for (const phase of standardPhases) {
        const resolved = resolvePinnedProfileForPhase({
          pinnedRuntime: runtime,
          phaseName: phase,
          config: realAgentConfig,
        });
        expect(resolved).toBeDefined();
        const profile = realAgentConfig.profiles[resolved];
        expect(
          profile,
          `Profile '${resolved}' must exist for runtime '${runtime}' in phase '${phase}'`,
        ).toBeDefined();
        expect(profile.runtime, `Profile '${resolved}' must have runtime '${runtime}'`).toBe(
          runtime,
        );
      }
    }
  });
});
