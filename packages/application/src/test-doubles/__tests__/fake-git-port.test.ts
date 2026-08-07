import { describe, expect, it } from 'vitest';
import { FakeGitPort } from '../fake-git-port.js';

describe('FakeGitPort.amendCommitMessage()', () => {
  it('updates most recent fake commit message by replacing HEAD commit', async () => {
    const fakeGit = new FakeGitPort();
    const originalSha = await fakeGit.commit('/test', 'original message');
    expect(fakeGit.commits).toHaveLength(1);
    expect(fakeGit.commits[0]?.message).toBe('original message');
    expect(fakeGit.commits[0]?.sha).toBe(originalSha);

    const amendedSha = await fakeGit.amendCommitMessage('/test', 'amended message');

    expect(amendedSha).not.toBe(originalSha);
    expect(await fakeGit.headCommitSha('/test')).toBe(amendedSha);
    expect(fakeGit.commits).toHaveLength(1);
    expect(fakeGit.commits[0]?.message).toBe('amended message');
    expect(fakeGit.commits[0]?.sha).toBe(amendedSha);
  });

  it('does not cause SHA collisions for subsequent commits after amending', async () => {
    const fakeGit = new FakeGitPort();
    const originalSha = await fakeGit.commit('/test', 'original message');
    const amendedSha = await fakeGit.amendCommitMessage('/test', 'amended message');
    const subsequentSha = await fakeGit.commit('/test', 'subsequent message');

    expect(originalSha).not.toBe(amendedSha);
    expect(amendedSha).not.toBe(subsequentSha);
    expect(subsequentSha).not.toBe(originalSha);
  });

  it('amends the current HEAD commit even after HEAD was moved', async () => {
    const fakeGit = new FakeGitPort();
    const firstSha = await fakeGit.commit('/test', 'first message');
    const secondSha = await fakeGit.commit('/test', 'second message');
    await fakeGit.resetHard('/test', firstSha);

    const amendedSha = await fakeGit.amendCommitMessage('/test', 'amended first message');

    expect(fakeGit.commits).toHaveLength(2);
    expect(fakeGit.commits[0]?.sha).toBe(amendedSha);
    expect(fakeGit.commits[0]?.message).toBe('amended first message');
    expect(fakeGit.commits[1]?.sha).toBe(secondSha);
    expect(fakeGit.commits[1]?.message).toBe('second message');
  });
});
