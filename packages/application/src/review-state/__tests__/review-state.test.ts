import { describe, expect, it } from 'vitest';
import { normalizeSummary, fingerprintFinding } from '../fingerprint.js';

describe('fingerprint', () => {
  describe('normalizeSummary', () => {
    it('trims whitespace', () => {
      expect(normalizeSummary('  hello world  ')).toBe('hello world');
    });

    it('converts to lowercase', () => {
      expect(normalizeSummary('Hello World')).toBe('hello world');
    });

    it('collapses internal whitespace', () => {
      expect(normalizeSummary('hello   world')).toBe('hello world');
    });

    it('handles mixed case and whitespace', () => {
      expect(normalizeSummary('  Hello   WORLD  ')).toBe('hello world');
    });
  });

  describe('fingerprintFinding', () => {
    it('produces stable fingerprints for same input', async () => {
      const fp1 = await fingerprintFinding('quality', 'high', 'Missing error handling');
      const fp2 = await fingerprintFinding('quality', 'high', 'Missing error handling');
      expect(fp1).toBe(fp2);
    });

    it('produces same fingerprint regardless of case', async () => {
      const fp1 = await fingerprintFinding('QUALITY', 'HIGH', 'Missing error handling');
      const fp2 = await fingerprintFinding('quality', 'high', 'missing error handling');
      expect(fp1).toBe(fp2);
    });

    it('produces different fingerprints for different summaries', async () => {
      const fp1 = await fingerprintFinding('quality', 'high', 'Missing error handling');
      const fp2 = await fingerprintFinding('quality', 'high', 'Wrong error message');
      expect(fp1).not.toBe(fp2);
    });

    it('produces different fingerprints for different severities', async () => {
      const fp1 = await fingerprintFinding('quality', 'high', 'Missing error handling');
      const fp2 = await fingerprintFinding('quality', 'medium', 'Missing error handling');
      expect(fp1).not.toBe(fp2);
    });

    it('produces different fingerprints for different reviewer kinds', async () => {
      const fp1 = await fingerprintFinding('quality', 'high', 'Missing error handling');
      const fp2 = await fingerprintFinding('architect', 'high', 'Missing error handling');
      expect(fp1).not.toBe(fp2);
    });

    it('includes path when provided', async () => {
      const fp1 = await fingerprintFinding(
        'quality',
        'high',
        'Missing error handling',
        'src/app.ts',
      );
      const fp2 = await fingerprintFinding(
        'quality',
        'high',
        'Missing error handling',
        'src/utils.ts',
      );
      expect(fp1).not.toBe(fp2);
    });

    it('includes citation when provided', async () => {
      const fp1 = await fingerprintFinding(
        'quality',
        'high',
        'Missing error handling',
        undefined,
        'line 42',
      );
      const fp2 = await fingerprintFinding(
        'quality',
        'high',
        'Missing error handling',
        undefined,
        'line 99',
      );
      expect(fp1).not.toBe(fp2);
    });

    it('produces 64-character hex string', async () => {
      const fp = await fingerprintFinding('quality', 'high', 'Test');
      expect(fp).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
