import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface RetryIdentityInput {
  normalizedPhase: string;
  profile: string;
  promptHash: string;
  startCommitSha: string;
  relevantArtifactPaths: string[];
  classification: string;
  cwd: string;
}

export function generateRetryIdentity(input: RetryIdentityInput): string {
  const pairs = input.relevantArtifactPaths.map((artPath) => {
    const absolutePath = join(input.cwd, artPath);
    const normalizedPath = relative(input.cwd, absolutePath).replace(/\\/g, '/');

    let hashOrMissing = 'missing';
    if (existsSync(absolutePath)) {
      try {
        const content = readFileSync(absolutePath);
        hashOrMissing = createHash('sha256').update(content).digest('hex');
      } catch {
        hashOrMissing = 'missing';
      }
    }
    return [normalizedPath, hashOrMissing] as [string, string];
  });

  pairs.sort((a, b) => a[0].localeCompare(b[0]));

  const payload = {
    normalizedPhase: input.normalizedPhase,
    profile: input.profile,
    promptHash: input.promptHash,
    startCommitSha: input.startCommitSha,
    artifactPairs: pairs,
    classification: input.classification,
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
