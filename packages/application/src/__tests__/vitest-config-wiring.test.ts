import { describe, it, expect } from 'vitest';
import {
  findUnwiredVitestConfigs,
  formatUnwiredVitestConfigsMessage,
} from '../vitest-config-wiring.js';

describe('findUnwiredVitestConfigs', () => {
  it('reproduces the WhisperX incident: new config + script exist, but script is not wired', () => {
    const findings = findUnwiredVitestConfigs({
      createdFiles: ['vitest.whisperx.config.ts', 'scripts/whisperx_align.py'],
      packageJsonScripts: {
        'test:whisperx':
          'bash scripts/check-whisperx-version.sh && vitest run --config vitest.whisperx.config.ts',
        'test:kokoro':
          'bash scripts/check-kokoro-version.sh && vitest run --config vitest.kokoro.config.ts',
      },
      resolvedCommands: [
        'pnpm build',
        'pnpm lint',
        'pnpm test',
        'pnpm test:kokoro',
        'pnpm check:control-plane',
      ],
    });

    expect(findings).toEqual([{ file: 'vitest.whisperx.config.ts', script: 'test:whisperx' }]);
  });

  it('passes when the corresponding script is wired into resolvedCommands', () => {
    const findings = findUnwiredVitestConfigs({
      createdFiles: ['vitest.whisperx.config.ts'],
      packageJsonScripts: {
        'test:whisperx': 'vitest run --config vitest.whisperx.config.ts',
      },
      resolvedCommands: ['pnpm build', 'pnpm test:whisperx'],
    });

    expect(findings).toEqual([]);
  });

  it('flags a new config with no referencing package.json script at all', () => {
    const findings = findUnwiredVitestConfigs({
      createdFiles: ['vitest.piper.config.ts'],
      packageJsonScripts: {
        'test:kokoro': 'vitest run --config vitest.kokoro.config.ts',
      },
      resolvedCommands: ['pnpm build'],
    });

    expect(findings).toEqual([{ file: 'vitest.piper.config.ts', script: undefined }]);
  });

  it('does not flag a config explicitly excused via knownUnwired (LTX-style GPU-only case)', () => {
    const findings = findUnwiredVitestConfigs({
      createdFiles: ['vitest.ltx.config.ts'],
      packageJsonScripts: {
        'test:ltx-production': 'vitest run --config vitest.ltx.config.ts',
      },
      resolvedCommands: ['pnpm build'],
      knownUnwired: [
        {
          file: 'vitest.ltx.config.ts',
          reason: 'Requires real GPU/ComfyUI hardware the orchestrator sandbox does not have.',
        },
      ],
    });

    expect(findings).toEqual([]);
  });

  it('never flags pre-existing configs that were merely modified, not created', () => {
    const findings = findUnwiredVitestConfigs({
      createdFiles: ['packages/application/src/use-cases/some-new-file.ts'],
      packageJsonScripts: {
        'test:db': 'vitest run --config vitest.integration.config.ts',
      },
      resolvedCommands: ['pnpm build'],
    });

    expect(findings).toEqual([]);
  });

  it('never flags the two standard configs by name shape (no middle segment / already the integration convention)', () => {
    const findings = findUnwiredVitestConfigs({
      createdFiles: ['vitest.config.ts'],
      packageJsonScripts: {},
      resolvedCommands: [],
    });

    expect(findings).toEqual([]);
  });

  it('handles multiple new unwired configs in one run', () => {
    const findings = findUnwiredVitestConfigs({
      createdFiles: ['vitest.whisperx.config.ts', 'vitest.piper.config.ts'],
      packageJsonScripts: {
        'test:whisperx': 'vitest run --config vitest.whisperx.config.ts',
      },
      resolvedCommands: ['pnpm build'],
    });

    expect(findings).toEqual([
      { file: 'vitest.whisperx.config.ts', script: 'test:whisperx' },
      { file: 'vitest.piper.config.ts', script: undefined },
    ]);
  });

  it('matches script references using a relative ./ prefix', () => {
    const findings = findUnwiredVitestConfigs({
      createdFiles: ['vitest.whisperx.config.ts'],
      packageJsonScripts: {
        'test:whisperx': 'vitest run --config ./vitest.whisperx.config.ts',
      },
      resolvedCommands: ['pnpm test:whisperx'],
    });

    expect(findings).toEqual([]);
  });
});

describe('formatUnwiredVitestConfigsMessage', () => {
  it('includes the file, the script name when known, and actionable next steps', () => {
    const message = formatUnwiredVitestConfigsMessage([
      { file: 'vitest.whisperx.config.ts', script: 'test:whisperx' },
    ]);
    expect(message).toContain('vitest.whisperx.config.ts');
    expect(message).toContain('test:whisperx');
    expect(message).toContain('validation.additionalCommands');
    expect(message).toContain('knownUnwiredVitestConfigs');
  });

  it('handles a finding with no known script', () => {
    const message = formatUnwiredVitestConfigsMessage([{ file: 'vitest.piper.config.ts' }]);
    expect(message).toContain('no package.json script found');
  });
});
