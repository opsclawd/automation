import { describe, expect, it } from 'vitest';
import { generateRetryIdentity } from '../retry-identity.js';
import { writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

describe('retry-identity', () => {
  it('generates a stable sorted identity regardless of the order of relevantArtifactPaths', () => {
    const tmp = join(os.tmpdir(), `retry-identity-test-${randomUUID()}`);
    mkdirSync(tmp, { recursive: true });

    const fileA = join(tmp, 'a.txt');
    const fileB = join(tmp, 'b.txt');
    writeFileSync(fileA, 'hello', 'utf-8');
    writeFileSync(fileB, 'world', 'utf-8');

    const baseInput = {
      normalizedPhase: 'phase-1',
      profile: 'profile-a',
      promptHash: 'prompt-hash-1',
      startCommitSha: 'commit-1',
      classification: 'semantic',
      cwd: tmp,
    };

    const identity1 = generateRetryIdentity({
      ...baseInput,
      relevantArtifactPaths: ['a.txt', 'b.txt'],
    });

    const identity2 = generateRetryIdentity({
      ...baseInput,
      relevantArtifactPaths: ['b.txt', 'a.txt'],
    });

    expect(identity1).toBe(identity2);
  });

  it('marks non-existent files as missing', () => {
    const tmp = join(os.tmpdir(), `retry-identity-test-${randomUUID()}`);
    mkdirSync(tmp, { recursive: true });

    const baseInput = {
      normalizedPhase: 'phase-1',
      profile: 'profile-a',
      promptHash: 'prompt-hash-1',
      startCommitSha: 'commit-1',
      classification: 'semantic',
      cwd: tmp,
      relevantArtifactPaths: ['nonexistent.txt'],
    };

    const identity1 = generateRetryIdentity(baseInput);
    const identity2 = generateRetryIdentity(baseInput);
    expect(identity1).toBe(identity2);
  });

  it('detects changed components (different hash when files change)', () => {
    const tmp = join(os.tmpdir(), `retry-identity-test-${randomUUID()}`);
    mkdirSync(tmp, { recursive: true });

    const fileA = join(tmp, 'a.txt');
    writeFileSync(fileA, 'hello', 'utf-8');

    const baseInput = {
      normalizedPhase: 'phase-1',
      profile: 'profile-a',
      promptHash: 'prompt-hash-1',
      startCommitSha: 'commit-1',
      classification: 'semantic',
      cwd: tmp,
      relevantArtifactPaths: ['a.txt'],
    };

    const identityOriginal = generateRetryIdentity(baseInput);

    // change file content
    writeFileSync(fileA, 'hello changed', 'utf-8');
    const identityContentChanged = generateRetryIdentity(baseInput);
    expect(identityContentChanged).not.toBe(identityOriginal);

    // change start commit
    const identityCommitChanged = generateRetryIdentity({
      ...baseInput,
      startCommitSha: 'commit-2',
    });
    expect(identityCommitChanged).not.toBe(identityOriginal);

    // change classification
    const identityClassificationChanged = generateRetryIdentity({
      ...baseInput,
      classification: 'different',
    });
    expect(identityClassificationChanged).not.toBe(identityOriginal);
  });

  it('has no mtime sensitivity', () => {
    const tmp = join(os.tmpdir(), `retry-identity-test-${randomUUID()}`);
    mkdirSync(tmp, { recursive: true });

    const fileA = join(tmp, 'a.txt');
    writeFileSync(fileA, 'hello', 'utf-8');

    const baseInput = {
      normalizedPhase: 'phase-1',
      profile: 'profile-a',
      promptHash: 'prompt-hash-1',
      startCommitSha: 'commit-1',
      classification: 'semantic',
      cwd: tmp,
      relevantArtifactPaths: ['a.txt'],
    };

    const identityOriginal = generateRetryIdentity(baseInput);

    // Change access & modification times of the file
    const newTime = new Date(Date.now() - 10000);
    utimesSync(fileA, newTime, newTime);

    const identityTimeChanged = generateRetryIdentity(baseInput);
    expect(identityTimeChanged).toBe(identityOriginal);
  });
});
