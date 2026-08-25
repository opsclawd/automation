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

describe('FakeGitPort.commit()', () => {
  it('records a defensive copy of the optional commit pathspec', async () => {
    const fakeGit = new FakeGitPort();
    const files = ['src/a.ts'];
    const commitWithPathspec = fakeGit.commit.bind(fakeGit) as (
      cwd: string,
      message: string,
      files?: readonly string[],
    ) => Promise<string>;

    await commitWithPathspec('/test', 'scoped commit', files);
    files.push('src/b.ts');

    const commits = fakeGit.commits as Array<{ files?: readonly string[] }>;
    expect(commits[0]?.files).toEqual(['src/a.ts']);
  });
});

describe('FakeGitPort.createdFiles()', () => {
  it('records createdFiles calls and returns configured paths', async () => {
    const fakeGit = new FakeGitPort();
    fakeGit.createdFilesResults.set('base|head', ['src/a.ts', 'src/b.ts']);

    const files = await fakeGit.createdFiles('/test', 'base', 'head');
    expect(files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(fakeGit.createdFilesCalls).toEqual([{ cwd: '/test', base: 'base', head: 'head' }]);

    const defaultFiles = await fakeGit.createdFiles('/test', 'base');
    expect(defaultFiles).toEqual([]);
    expect(fakeGit.createdFilesCalls).toHaveLength(2);
  });
});

describe('FakeGitPort.fileContent()', () => {
  it('records fileContent calls and returns configured historical text', async () => {
    const fakeGit = new FakeGitPort();
    fakeGit.fileContentResults.set('main:src/a.ts', 'const a = 1;\n');

    const content = await fakeGit.fileContent('/test', 'main', 'src/a.ts');
    expect(content).toBe('const a = 1;\n');
    expect(fakeGit.fileContentCalls).toEqual([{ cwd: '/test', ref: 'main', path: 'src/a.ts' }]);

    const defaultContent = await fakeGit.fileContent('/test', 'HEAD', 'src/b.ts');
    expect(defaultContent).toBe('fake content for HEAD:src/b.ts');
  });
});

describe('FakeGitPort.checkout()', () => {
  it('records checkout calls and paths', async () => {
    const fakeGit = new FakeGitPort();
    await fakeGit.checkout('/test', 'HEAD', ['src/a.ts']);
    expect(fakeGit.checkoutCalls).toEqual([{ cwd: '/test', ref: 'HEAD', files: ['src/a.ts'] }]);
  });
});
