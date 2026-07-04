import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  findMisplacedCandidate,
  moveMisplacedArtifact,
  remediateMissingArtifacts,
} from '../artifact-remediation.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: vi.fn((src: string, dest: string) => actual.renameSync(src, dest)),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'artifact-remediation-test-'));
}

function makeGitRepo(dir: string): string {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@test.com', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name test', { cwd: dir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'pipe' });
  return execSync('git rev-parse HEAD', { cwd: dir, stdio: 'pipe' }).toString().trim();
}

describe('findMisplacedCandidate', () => {
  it('returns the relative path of a unique untracked file matching the basename at depth 2+', () => {
    const cwd = makeTmpDir();
    try {
      makeGitRepo(cwd);
      mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true });
      const filePath = join(cwd, 'docs', 'specs', 'design.md');
      writeFileSync(filePath, '# Design');
      const startMs = Date.now();
      const futureSec = (startMs + 2000) / 1000;
      utimesSync(filePath, futureSec, futureSec);
      const result = findMisplacedCandidate(cwd, 'design.md', startMs);
      expect(result).toBe('docs/specs/design.md');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns null when multiple untracked matches exist', () => {
    const cwd = makeTmpDir();
    try {
      makeGitRepo(cwd);
      mkdirSync(join(cwd, 'docs', 'a'), { recursive: true });
      mkdirSync(join(cwd, 'docs', 'b'), { recursive: true });
      const fileA = join(cwd, 'docs', 'a', 'design.md');
      const fileB = join(cwd, 'docs', 'b', 'design.md');
      writeFileSync(fileA, '# A');
      writeFileSync(fileB, '# B');
      const startMs = Date.now();
      const futureSec = (startMs + 2000) / 1000;
      utimesSync(fileA, futureSec, futureSec);
      utimesSync(fileB, futureSec, futureSec);
      const result = findMisplacedCandidate(cwd, 'design.md', startMs);
      expect(result).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns null when the only match is git-tracked', () => {
    const cwd = makeTmpDir();
    try {
      makeGitRepo(cwd);
      mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true });
      const filePath = join(cwd, 'docs', 'specs', 'design.md');
      writeFileSync(filePath, '# Tracked');
      execSync('git add docs/specs/design.md', { cwd, stdio: 'pipe' });
      execSync('git commit -m "add tracked design"', { cwd, stdio: 'pipe' });
      const startMs = Date.now();
      const futureSec = (startMs + 2000) / 1000;
      utimesSync(filePath, futureSec, futureSec);
      const result = findMisplacedCandidate(cwd, 'design.md', startMs);
      expect(result).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('skips NOISE_DIRS', () => {
    const cwd = makeTmpDir();
    try {
      makeGitRepo(cwd);
      mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true });
      const filePath = join(cwd, 'node_modules', 'pkg', 'design.md');
      writeFileSync(filePath, '# Noise');
      const startMs = Date.now();
      const futureSec = (startMs + 2000) / 1000;
      utimesSync(filePath, futureSec, futureSec);
      const result = findMisplacedCandidate(cwd, 'design.md', startMs);
      expect(result).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('honors excludePaths', () => {
    const cwd = makeTmpDir();
    try {
      makeGitRepo(cwd);
      mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true });
      const filePath = join(cwd, 'docs', 'specs', 'design.md');
      writeFileSync(filePath, '# Design');
      const startMs = Date.now();
      const futureSec = (startMs + 2000) / 1000;
      utimesSync(filePath, futureSec, futureSec);
      const excludePaths = new Set(['docs/specs/design.md']);
      const result = findMisplacedCandidate(cwd, 'design.md', startMs, excludePaths);
      expect(result).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('ignores stale files (mtime < startMs)', () => {
    const cwd = makeTmpDir();
    try {
      makeGitRepo(cwd);
      mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true });
      const filePath = join(cwd, 'docs', 'specs', 'design.md');
      writeFileSync(filePath, '# Stale Design');

      const startMs = Date.now();
      const pastSec = (startMs - 5000) / 1000;
      utimesSync(filePath, pastSec, pastSec);

      const result = findMisplacedCandidate(cwd, 'design.md', startMs);
      expect(result).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('moveMisplacedArtifact', () => {
  it('creates missing destination directories', () => {
    const cwd = makeTmpDir();
    try {
      makeGitRepo(cwd);
      mkdirSync(join(cwd, 'temp_docs'), { recursive: true });
      writeFileSync(join(cwd, 'temp_docs', 'plan.md'), '# Nested Plan');
      moveMisplacedArtifact(cwd, 'temp_docs/plan.md', 'nested/docs/plan.md');
      expect(existsSync(join(cwd, 'nested', 'docs', 'plan.md'))).toBe(true);
      expect(readFileSync(join(cwd, 'nested', 'docs', 'plan.md'), 'utf-8')).toBe('# Nested Plan');
      expect(existsSync(join(cwd, 'temp_docs', 'plan.md'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('cleans empty ancestor directories up to cwd after a successful move', () => {
    const cwd = makeTmpDir();
    try {
      makeGitRepo(cwd);
      const specDir = join(cwd, 'docs', 'superpowers', 'specs');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, 'design.md'), '# Design');
      moveMisplacedArtifact(cwd, 'docs/superpowers/specs/design.md', 'design.md');
      expect(existsSync(join(cwd, 'design.md'))).toBe(true);
      expect(existsSync(join(cwd, 'docs', 'superpowers', 'specs'))).toBe(false);
      expect(existsSync(join(cwd, 'docs'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('falls back to copy+unlink when renameSync throws EXDEV', () => {
    const cwd = makeTmpDir();
    try {
      makeGitRepo(cwd);
      mkdirSync(join(cwd, 'sub'), { recursive: true });
      writeFileSync(join(cwd, 'sub', 'file.md'), '# EXDEV');

      vi.mocked(renameSync).mockImplementationOnce(() => {
        const err = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
        throw err;
      });

      moveMisplacedArtifact(cwd, 'sub/file.md', 'file.md');

      expect(existsSync(join(cwd, 'file.md'))).toBe(true);
      expect(readFileSync(join(cwd, 'file.md'), 'utf-8')).toBe('# EXDEV');
      expect(existsSync(join(cwd, 'sub', 'file.md'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('recovers from sourceDir with copyOnly: true', () => {
    const cwd = makeTmpDir();
    const sourceDir = makeTmpDir();
    try {
      makeGitRepo(cwd);
      makeGitRepo(sourceDir);
      mkdirSync(join(sourceDir, 'apps', 'cli'), { recursive: true });
      const strayPath = join(sourceDir, 'apps', 'cli', 'result.json');
      writeFileSync(strayPath, '{"found":true}');

      const startMs = Date.now();
      const futureSec = (startMs + 2000) / 1000;
      utimesSync(strayPath, futureSec, futureSec);

      const result = remediateMissingArtifacts({
        cwd,
        startMs,
        expectedArtifacts: ['result.json'],
        stderrForLog: '',
        sourceDir,
        copyOnly: true,
      });

      expect(result.remediatedArtifacts).toEqual([
        { src: 'apps/cli/result.json', artifact: 'result.json' },
      ]);
      expect(existsSync(join(cwd, 'result.json'))).toBe(true);
      expect(readFileSync(join(cwd, 'result.json'), 'utf-8')).toBe('{"found":true}');
      // copyOnly: true should NOT delete the source
      expect(existsSync(strayPath)).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it('recovers stem-prefix from sourceDir with copyOnly: true', () => {
    const cwd = makeTmpDir();
    const sourceDir = makeTmpDir();
    try {
      makeGitRepo(cwd);
      makeGitRepo(sourceDir);
      const strayPath = join(sourceDir, 'implementation-log-task-1.md');
      writeFileSync(strayPath, '{"stem":true}');

      const startMs = Date.now();
      const futureSec = (startMs + 2000) / 1000;
      utimesSync(strayPath, futureSec, futureSec);

      const result = remediateMissingArtifacts({
        cwd,
        startMs,
        expectedArtifacts: ['implementation-log.md'],
        stderrForLog: '',
        sourceDir,
        copyOnly: true,
      });

      expect(result.remediatedArtifacts).toEqual([
        { src: 'implementation-log-task-1.md', artifact: 'implementation-log.md' },
      ]);
      expect(existsSync(join(cwd, 'implementation-log.md'))).toBe(true);
      expect(readFileSync(join(cwd, 'implementation-log.md'), 'utf-8')).toBe('{"stem":true}');
      // copyOnly: true should NOT delete the source
      expect(existsSync(strayPath)).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});

describe('remediateMissingArtifacts', () => {
  it('returns remediatedArtifacts populated for a single basename recovery', () => {
    const cwd = makeTmpDir();
    try {
      makeGitRepo(cwd);
      mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true });
      const filePath = join(cwd, 'docs', 'specs', 'design.md');
      writeFileSync(filePath, '# Design');

      const startMs = Date.now();
      const futureSec = (startMs + 2000) / 1000;
      utimesSync(filePath, futureSec, futureSec);

      const result = remediateMissingArtifacts({
        cwd,
        startMs,
        expectedArtifacts: ['design.md'],
        stderrForLog: '',
      });

      expect(result.remediatedArtifacts).toEqual([
        { src: 'docs/specs/design.md', artifact: 'design.md' },
      ]);
      expect(result.missingArtifacts).toEqual([]);
      expect(existsSync(join(cwd, 'design.md'))).toBe(true);
      expect(readFileSync(join(cwd, 'design.md'), 'utf-8')).toBe('# Design');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns missingArtifacts populated when nothing is recoverable', () => {
    const cwd = makeTmpDir();
    try {
      makeGitRepo(cwd);

      const result = remediateMissingArtifacts({
        cwd,
        startMs: Date.now(),
        expectedArtifacts: ['design.md'],
        stderrForLog: '',
      });

      expect(result.remediatedArtifacts).toEqual([]);
      expect(result.missingArtifacts).toEqual(['design.md']);
      expect(existsSync(join(cwd, 'design.md'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('picks the newest mtime stem-prefix candidate and ignores stale ones', () => {
    const cwd = makeTmpDir();
    try {
      makeGitRepo(cwd);
      writeFileSync(join(cwd, 'implementation-log-task-1.md'), 'old-fresh');
      writeFileSync(join(cwd, 'implementation-log-task-2.md'), 'new-fresh');
      writeFileSync(join(cwd, 'implementation-log-task-3.md'), 'stale');

      const startMs = Date.now();
      const startSec = startMs / 1000;
      utimesSync(join(cwd, 'implementation-log-task-1.md'), startSec + 60, startSec + 60);
      utimesSync(join(cwd, 'implementation-log-task-2.md'), startSec + 120, startSec + 120);
      utimesSync(join(cwd, 'implementation-log-task-3.md'), startSec - 120, startSec - 120);

      const result = remediateMissingArtifacts({
        cwd,
        startMs,
        expectedArtifacts: ['implementation-log.md'],
        stderrForLog: '',
      });

      expect(result.remediatedArtifacts).toEqual([
        { src: 'implementation-log-task-2.md', artifact: 'implementation-log.md' },
      ]);
      expect(result.missingArtifacts).toEqual([]);
      expect(existsSync(join(cwd, 'implementation-log.md'))).toBe(true);
      expect(readFileSync(join(cwd, 'implementation-log.md'), 'utf-8')).toBe('new-fresh');
      expect(existsSync(join(cwd, 'implementation-log-task-2.md'))).toBe(false);
      expect(existsSync(join(cwd, 'implementation-log-task-1.md'))).toBe(true);
      expect(existsSync(join(cwd, 'implementation-log-task-3.md'))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('appends STEM_PREFIX_REMEDIATED: lines to stderrForLog', () => {
    const cwd = makeTmpDir();
    try {
      makeGitRepo(cwd);
      writeFileSync(join(cwd, 'implementation-log-task-9.md'), 'remediated');

      const startMs = Date.now();
      const startSec = startMs / 1000;
      utimesSync(join(cwd, 'implementation-log-task-9.md'), startSec + 120, startSec + 120);

      const opts = {
        cwd,
        startMs,
        expectedArtifacts: ['implementation-log.md'],
        stderrForLog: '',
      };
      remediateMissingArtifacts(opts);

      expect(opts.stderrForLog).toContain(
        'STEM_PREFIX_REMEDIATED: implementation-log-task-9.md → implementation-log.md',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('deletes the stem-prefix source after copy when the source is untracked', () => {
    const cwd = makeTmpDir();
    try {
      makeGitRepo(cwd);
      writeFileSync(join(cwd, 'implementation-log-task-1.md'), 'untracked');

      const startMs = Date.now();
      const startSec = startMs / 1000;
      utimesSync(join(cwd, 'implementation-log-task-1.md'), startSec + 120, startSec + 120);

      const result = remediateMissingArtifacts({
        cwd,
        startMs,
        expectedArtifacts: ['implementation-log.md'],
        stderrForLog: '',
      });

      expect(result.remediatedArtifacts).toHaveLength(1);
      expect(existsSync(join(cwd, 'implementation-log-task-1.md'))).toBe(false);
      expect(existsSync(join(cwd, 'implementation-log.md'))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('leaves the stem-prefix source intact when it is git-tracked', () => {
    const cwd = makeTmpDir();
    try {
      makeGitRepo(cwd);
      writeFileSync(join(cwd, 'implementation-log-task-1.md'), 'tracked');
      execSync('git add implementation-log-task-1.md', { cwd, stdio: 'pipe' });
      execSync('git commit -m "add tracked source"', { cwd, stdio: 'pipe' });

      const startMs = Date.now();
      const startSec = startMs / 1000;
      utimesSync(join(cwd, 'implementation-log-task-1.md'), startSec + 120, startSec + 120);

      const result = remediateMissingArtifacts({
        cwd,
        startMs,
        expectedArtifacts: ['implementation-log.md'],
        stderrForLog: '',
      });

      expect(result.remediatedArtifacts).toHaveLength(1);
      expect(existsSync(join(cwd, 'implementation-log-task-1.md'))).toBe(true);
      expect(existsSync(join(cwd, 'implementation-log.md'))).toBe(true);
      expect(readFileSync(join(cwd, 'implementation-log.md'), 'utf-8')).toBe('tracked');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
