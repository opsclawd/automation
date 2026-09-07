import { describe, it, expect } from 'vitest';
import { formatValidationFailures } from '../format-validation-failures.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';

describe('formatValidationFailures', () => {
  const RUN_UUID = '550e8400-e29b-41d4-a716-446655440000';

  it('returns raw string when failureJson is not valid JSON', async () => {
    const artifacts = new FakeArtifactStore();
    const result = await formatValidationFailures('plain error text', artifacts, RUN_UUID);
    expect(result).toBe('plain error text');
  });

  it('returns raw string when parsed JSON is not an object', async () => {
    const artifacts = new FakeArtifactStore();
    const result = await formatValidationFailures('"just a string"', artifacts, RUN_UUID);
    expect(result).toBe('"just a string"');
  });

  it('returns failure.message when artifacts is missing or empty', async () => {
    const artifacts = new FakeArtifactStore();
    const failureJson = JSON.stringify({ phase: 'validate', message: 'build failed' });
    const result = await formatValidationFailures(failureJson, artifacts, RUN_UUID);
    expect(result).toBe('build failed');
  });

  it('excludes non-.log artifacts such as validation-result.json', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: RUN_UUID,
      relativePath: 'validate/validation-result.json',
      contents: '{"passed":false}',
    });

    const failureJson = JSON.stringify({
      phase: 'validate',
      message: 'validation failed',
      artifacts: ['validate/validation-result.json'],
    });

    const result = await formatValidationFailures(failureJson, artifacts, RUN_UUID);
    expect(result).toBe('validation failed');
    expect(result).not.toContain('validation-result.json');
  });

  it('embeds log content with banner delimiters for readable .log artifacts', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: RUN_UUID,
      relativePath: 'validate/0-test.stderr.log',
      contents: 'Error: expected true but received false\n  at test.ts:15:10',
    });

    const failureJson = JSON.stringify({
      phase: 'validate',
      message: '1 validation command(s) failed: test (exit 1). See validate/ logs.',
      artifacts: ['validate/0-test.stderr.log'],
    });

    const result = await formatValidationFailures(failureJson, artifacts, RUN_UUID);
    expect(result).toContain('1 validation command(s) failed');
    expect(result).toContain('--- validate/0-test.stderr.log (last 100 lines) ---');
    expect(result).toContain('Error: expected true but received false');
  });

  it('tails long logs to the last N lines', async () => {
    const artifacts = new FakeArtifactStore();
    const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}: diagnostic output`);
    await artifacts.write({
      runId: RUN_UUID,
      relativePath: 'validate/0-build.stderr.log',
      contents: lines.join('\n'),
    });

    const failureJson = JSON.stringify({
      phase: 'validate',
      message: 'build failed',
      artifacts: ['validate/0-build.stderr.log'],
    });

    const result = await formatValidationFailures(failureJson, artifacts, RUN_UUID, {
      maxLinesPerArtifact: 100,
    });

    expect(result).toContain('--- validate/0-build.stderr.log (last 100 lines) ---');
    expect(result).not.toContain('line 1: diagnostic output');
    expect(result).not.toContain('line 50: diagnostic output');
    expect(result).toContain('line 51: diagnostic output');
    expect(result).toContain('line 150: diagnostic output');
  });

  it('enforces a byte ceiling per artifact for single-line or huge outputs', async () => {
    const artifacts = new FakeArtifactStore();
    const hugeLine = 'x'.repeat(1000);
    await artifacts.write({
      runId: RUN_UUID,
      relativePath: 'validate/0-build.stderr.log',
      contents: hugeLine,
    });

    const failureJson = JSON.stringify({
      phase: 'validate',
      message: 'build failed',
      artifacts: ['validate/0-build.stderr.log'],
    });

    const result = await formatValidationFailures(failureJson, artifacts, RUN_UUID, {
      maxBytesPerArtifact: 100,
    });

    expect(result).toContain('--- validate/0-build.stderr.log (last 100 lines) ---');
    // Content should be capped to 100 bytes
    const sectionBody = result.split('--- validate/0-build.stderr.log (last 100 lines) ---\n')[1];
    expect(Buffer.byteLength(sectionBody!, 'utf-8')).toBe(100);
  });

  it('silently omits empty or whitespace-only log artifacts (Finding 3)', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: RUN_UUID,
      relativePath: 'validate/0-test.stdout.log',
      contents: '   \n\t  \n  ',
    });
    await artifacts.write({
      runId: RUN_UUID,
      relativePath: 'validate/0-test.stderr.log',
      contents: 'Real error: timeout after 120000ms',
    });

    const failureJson = JSON.stringify({
      phase: 'validate',
      message: '1 command failed',
      artifacts: ['validate/0-test.stdout.log', 'validate/0-test.stderr.log'],
    });

    const result = await formatValidationFailures(failureJson, artifacts, RUN_UUID);
    expect(result).not.toContain('validate/0-test.stdout.log');
    expect(result).not.toContain('(artifact unreadable)');
    expect(result).toContain('--- validate/0-test.stderr.log (last 100 lines) ---');
    expect(result).toContain('Real error: timeout after 120000ms');
  });

  it('returns just message when all log artifacts are empty', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: RUN_UUID,
      relativePath: 'validate/0-test.stdout.log',
      contents: '',
    });
    await artifacts.write({
      runId: RUN_UUID,
      relativePath: 'validate/0-test.stderr.log',
      contents: '  \n',
    });

    const failureJson = JSON.stringify({
      phase: 'validate',
      message: 'command failed',
      artifacts: ['validate/0-test.stdout.log', 'validate/0-test.stderr.log'],
    });

    const result = await formatValidationFailures(failureJson, artifacts, RUN_UUID);
    expect(result).toBe('command failed');
  });

  it('neutralizes runs of 3+ backticks in log content with fullwidth backticks (Finding 2)', async () => {
    const artifacts = new FakeArtifactStore();
    const vitestDiff =
      'Assertion error:\n```\n- expected\n+ received\n```\nExtra info ````fence````';
    await artifacts.write({
      runId: RUN_UUID,
      relativePath: 'validate/0-test.stderr.log',
      contents: vitestDiff,
    });

    const failureJson = JSON.stringify({
      phase: 'validate',
      message: 'test failed',
      artifacts: ['validate/0-test.stderr.log'],
    });

    const result = await formatValidationFailures(failureJson, artifacts, RUN_UUID);
    expect(result).not.toContain('```');
    expect(result).toContain('\uFF40\uFF40\uFF40');
    expect(result).toContain('\uFF40\uFF40\uFF40\uFF40');
  });

  it('marks unreadable artifacts with placeholder without failing', async () => {
    const artifacts = new FakeArtifactStore(); // artifact not written
    const failureJson = JSON.stringify({
      phase: 'validate',
      message: 'command failed',
      artifacts: ['validate/missing.log'],
    });

    const result = await formatValidationFailures(failureJson, artifacts, RUN_UUID);
    expect(result).toContain('--- validate/missing.log ---');
    expect(result).toContain('(artifact unreadable)');
  });

  it('stops appending and appends omitted note when total budget is exceeded', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: RUN_UUID,
      relativePath: 'validate/0-test.stderr.log',
      contents: 'Error 0: failure in component A',
    });
    await artifacts.write({
      runId: RUN_UUID,
      relativePath: 'validate/1-test.stderr.log',
      contents: 'Error 1: failure in component B',
    });
    await artifacts.write({
      runId: RUN_UUID,
      relativePath: 'validate/2-test.stderr.log',
      contents: 'Error 2: failure in component C',
    });

    const failureJson = JSON.stringify({
      phase: 'validate',
      message: 'failures',
      artifacts: [
        'validate/0-test.stderr.log',
        'validate/1-test.stderr.log',
        'validate/2-test.stderr.log',
      ],
    });

    // Small budget allowing only the first artifact + header
    const result = await formatValidationFailures(failureJson, artifacts, RUN_UUID, {
      totalBudgetBytes: 150,
    });

    expect(result).toContain('--- validate/0-test.stderr.log');
    expect(result).not.toContain('--- validate/1-test.stderr.log');
    expect(result).toContain('...2 more log artifact(s) omitted (budget exceeded)');
  });

  it('stops appending and appends omitted note when maxArtifacts is exceeded', async () => {
    const artifacts = new FakeArtifactStore();
    for (let i = 0; i < 4; i++) {
      await artifacts.write({
        runId: RUN_UUID,
        relativePath: `validate/${i}-test.stderr.log`,
        contents: `Error ${i}`,
      });
    }

    const failureJson = JSON.stringify({
      phase: 'validate',
      message: 'failures',
      artifacts: [0, 1, 2, 3].map((i) => `validate/${i}-test.stderr.log`),
    });

    const result = await formatValidationFailures(failureJson, artifacts, RUN_UUID, {
      maxArtifacts: 2,
    });

    expect(result).toContain('--- validate/0-test.stderr.log');
    expect(result).toContain('--- validate/1-test.stderr.log');
    expect(result).not.toContain('--- validate/2-test.stderr.log');
    expect(result).toContain('...2 more log artifact(s) omitted (budget exceeded)');
  });
});
