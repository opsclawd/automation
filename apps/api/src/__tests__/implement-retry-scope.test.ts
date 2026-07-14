import { describe, expect, it } from 'vitest';
import {
  canonicalizeAdditionalEditableFiles,
  renderImplementRetryScopePrompt,
  buildImplementRetryScopeMetadata,
} from '../implement-retry-scope.js';

describe('implement-retry-scope', () => {
  describe('canonicalizeAdditionalEditableFiles', () => {
    it('returns empty array when input is undefined', () => {
      expect(canonicalizeAdditionalEditableFiles(undefined)).toEqual([]);
    });

    it('returns empty array when input is empty array', () => {
      expect(canonicalizeAdditionalEditableFiles([])).toEqual([]);
    });

    it('sorts and deduplicates files', () => {
      const input = [
        'apps/api/src/compose.ts',
        'apps/api/src/cli.ts',
        'apps/api/src/compose.ts',
        'apps/api/src/cli.ts',
      ];
      expect(canonicalizeAdditionalEditableFiles(input)).toEqual([
        'apps/api/src/cli.ts',
        'apps/api/src/compose.ts',
      ]);
    });

    it('preserves order of first occurrence after sorting', () => {
      const input = ['z/file.ts', 'a/file.ts', 'm/file.ts'];
      expect(canonicalizeAdditionalEditableFiles(input)).toEqual([
        'a/file.ts',
        'm/file.ts',
        'z/file.ts',
      ]);
    });

    it('handles single file', () => {
      expect(canonicalizeAdditionalEditableFiles(['apps/api/src/cli.ts'])).toEqual([
        'apps/api/src/cli.ts',
      ]);
    });
  });

  describe('renderImplementRetryScopePrompt', () => {
    it('returns empty array when files is empty', () => {
      const result = renderImplementRetryScopePrompt([]);
      expect(result).toEqual([]);
    });

    it('returns empty array when files is undefined', () => {
      const result = renderImplementRetryScopePrompt(undefined);
      expect(result).toEqual([]);
    });

    it('retry prompt authorizes exactly the accumulated implicated files', () => {
      const files = ['apps/api/src/cli.ts', 'apps/api/src/compose.ts'];
      const result = renderImplementRetryScopePrompt(files);
      expect(result).toContain('## TYPECHECK-AUTHORIZED SCOPE OVERRIDE');
      expect(result).toContain(
        'The whole-repository typecheck directly implicated these existing files:',
      );
      expect(result).toContain('- apps/api/src/cli.ts');
      expect(result).toContain('- apps/api/src/compose.ts');
    });

    it('retry prompt keeps later-task prohibition outside the override', () => {
      const files = ['apps/api/src/cli.ts'];
      const result = renderImplementRetryScopePrompt(files);
      const block = result.join('\n');
      expect(block).toContain(
        'You may edit only these additional existing files, and only to resolve the',
      );
      expect(block).toContain(
        'listed compile failures. This narrow authorization overrides the later-task',
      );
      expect(block).toContain(
        'file prohibition for this retry; it does not authorize later-task behavior,',
      );
      expect(block).toContain('new files, dependencies, migrations, or unrelated refactors.');
    });

    it('initial and in-scope retries omit the override block', () => {
      const emptyResult = renderImplementRetryScopePrompt([]);
      expect(emptyResult).toEqual([]);
    });

    it('lists each file exactly once', () => {
      const files = ['a.ts', 'b.ts', 'c.ts'];
      const result = renderImplementRetryScopePrompt(files);
      const block = result.join('\n');
      const matches = block.match(/- a\.ts/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe('buildImplementRetryScopeMetadata', () => {
    it('returns undefined additional_editable_files when input is empty', () => {
      const result = buildImplementRetryScopeMetadata([]);
      expect(result.additional_editable_files).toBeUndefined();
    });

    it('returns undefined additional_editable_files when input is undefined', () => {
      const result = buildImplementRetryScopeMetadata(undefined);
      expect(result.additional_editable_files).toBeUndefined();
    });

    it('Agent Invocation metadata mirrors prompt authorization', () => {
      const files = ['apps/api/src/cli.ts', 'apps/api/src/compose.ts'];
      const metadata = buildImplementRetryScopeMetadata(files);
      expect(metadata.additional_editable_files).toEqual([
        'apps/api/src/cli.ts',
        'apps/api/src/compose.ts',
      ]);
    });

    it('manifest ownership remains unchanged', () => {
      const files = ['apps/api/src/cli.ts'];
      const result = buildImplementRetryScopeMetadata(files);
      expect(result).not.toHaveProperty('task_manifest');
      expect(result).not.toHaveProperty('manifest');
      expect(result).not.toHaveProperty('ownership');
    });

    it('returns sorted deduplicated list', () => {
      const files = ['z.ts', 'a.ts', 'z.ts', 'm.ts'];
      const result = buildImplementRetryScopeMetadata(files);
      expect(result.additional_editable_files).toEqual(['a.ts', 'm.ts', 'z.ts']);
    });
  });
});
