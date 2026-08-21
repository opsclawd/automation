import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

interface FixtureEntry {
  runId: string;
  issueNumber: number;
  repo: string;
  sourceDb: 'automation' | 'comfy-content-orchestrator';
  failureId: number;
  phase: string;
  failureKind: string;
  detectedAt: string;
  rawMessage: string;
  rawMessageSha256: string;
  path: string | null;
  pathSource:
    | 'undeclared_files'
    | 'reference_files'
    | 'worktree_dirty'
    | 'oscillation'
    | 'git_failed'
    | 'none';
  recoverable: boolean;
  truncatedCount: number | null;
  label: 'false_positive' | 'true_positive';
  rationale: string;
  taskManifest: null;
}

// ff2e91bc-eb8b-4eff-91c6-5b067f5d1e04 was in the original six-run candidate
// list but is intentionally absent from the labeled corpus: both of its
// failure rows (content oscillation, git-failed) are review-fix/PR-layer
// failures with no scope-permission question for classifyTaskChanges to
// answer. It's evidence for #978, not a scope-classifier fixture entry.
const EXPECTED_RUN_IDS = [
  '09f73f6f-eede-42fe-aaf4-694abc8ab686',
  'e0c4dd03-da65-4a26-97dd-5a2a6e52520c',
  '8ec8d952-21cc-423a-b8bf-025db1e2c7b2',
  '5dc78eb1-157a-4118-8894-631df496d448',
  '891a6fec-47b3-46b4-8983-cc954eabda6d',
];

// Runs queried for grounding verification -- includes ff2e91bc so a future
// change can't silently reintroduce it without the grounding test noticing.
const QUERIED_RUN_IDS = [...EXPECTED_RUN_IDS, 'ff2e91bc-eb8b-4eff-91c6-5b067f5d1e04'];

function loadEntries(): FixtureEntry[] {
  const path = join(__dirname, '../__fixtures__/scope-replay-corpus.json');
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureEntry[];
}

function findRepoRoot(): string {
  try {
    const out = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (out) return out.replace(/\/\.git$/, '');
  } catch {
    // fall through
  }
  return process.cwd();
}

function dbPathFor(sourceDb: 'automation' | 'comfy-content-orchestrator'): string | null {
  const repoRoot = findRepoRoot();
  if (sourceDb === 'automation') {
    return join(repoRoot, '.ai-runs/orchestrator.sqlite');
  }
  const parent = repoRoot.split('/').slice(0, -1).join('/');
  const comfy = join(parent, 'comfy-content-orchestrator/.ai-runs/orchestrator.sqlite');
  return comfy;
}

interface DbRow {
  id: number;
  message: string;
}

function loadDbRowsViaCli(sourceDb: 'automation' | 'comfy-content-orchestrator'): DbRow[] {
  const path = dbPathFor(sourceDb);
  if (!path || !existsSync(path)) return [];
  const sep = '\x1f';
  const inList = QUERIED_RUN_IDS.map((id) => `'${id}'`).join(',');
  const sql = `SELECT id, message FROM failures WHERE run_uuid IN (${inList})`;
  try {
    const out = execSync(
      `sqlite3 -separator ${JSON.stringify(sep)} "${path}" "${sql.replace(/"/g, '\\"')}"`,
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
      },
    ).toString();
    const rows: DbRow[] = [];
    for (const line of out.split('\n')) {
      if (!line) continue;
      const idx = line.indexOf(sep);
      if (idx === -1) continue;
      const id = Number.parseInt(line.slice(0, idx), 10);
      const message = line.slice(idx + 1);
      if (!Number.isNaN(id)) rows.push({ id, message });
    }
    return rows;
  } catch {
    return [];
  }
}

describe('scope-replay-corpus.json fixture', () => {
  const entries = loadEntries();

  it('exists as a static JSON artifact', () => {
    const path = join(__dirname, '../__fixtures__/scope-replay-corpus.json');
    expect(existsSync(path)).toBe(true);
  });

  it('covers all six boundary-halt runs', () => {
    const runIds = new Set(entries.map((e) => e.runId));
    for (const id of EXPECTED_RUN_IDS) {
      expect(runIds.has(id)).toBe(true);
    }
  });

  it('has provenance fields on every entry', () => {
    for (const e of entries) {
      expect(e.failureId).toBeGreaterThan(0);
      expect(e.detectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(e.sourceDb).toMatch(/^(automation|comfy-content-orchestrator)$/);
      expect(e.rawMessage.length).toBeGreaterThan(0);
    }
  });

  it('rawMessageSha256 matches the actual rawMessage content', () => {
    for (const e of entries) {
      const computed = createHash('sha256').update(e.rawMessage, 'utf8').digest('hex');
      expect(e.rawMessageSha256).toBe(computed);
    }
  });

  it('every entry has a human-approved label and rationale', () => {
    for (const e of entries) {
      expect(['false_positive', 'true_positive']).toContain(e.label);
      expect(typeof e.rationale).toBe('string');
      expect(e.rationale.length).toBeGreaterThan(10);
      expect(e.taskManifest).toBeNull();
    }
  });

  it('excludes pathSource values with no scope-permission question (oscillation, git_failed, none)', () => {
    for (const e of entries) {
      expect(['worktree_dirty', 'undeclared_files', 'reference_files']).toContain(e.pathSource);
    }
  });

  it('deliberately omits ff2e91bc-eb8b-4eff-91c6-5b067f5d1e04 (no scope-classification-relevant failures)', () => {
    const runIds = new Set(entries.map((e) => e.runId));
    expect(runIds.has('ff2e91bc-eb8b-4eff-91c6-5b067f5d1e04')).toBe(false);
  });

  it('recoverable=false matches truncatedCount or absent path', () => {
    for (const e of entries) {
      if (e.truncatedCount !== null) {
        expect(e.recoverable).toBe(false);
      }
      if (e.path === null) {
        expect(e.recoverable).toBe(false);
      }
    }
  });

  it('every recoverable entry has a non-null path that appears in rawMessage', () => {
    for (const e of entries) {
      if (!e.recoverable) continue;
      expect(e.path).not.toBeNull();
      expect(e.path).toBeTruthy();
      expect(e.pathSource).not.toBe('none');
      expect(e.rawMessage).toContain(e.path as string);
    }
  });

  it('every path with pathSource=worktree_dirty + truncatedCount appears with recoverable=false', () => {
    const truncated = entries.filter(
      (e) => e.pathSource === 'worktree_dirty' && e.truncatedCount !== null,
    );
    expect(truncated.length).toBeGreaterThan(0);
    for (const e of truncated) {
      expect(e.recoverable).toBe(false);
    }
  });

  it('every fixture entry is grounded in a real DB row by failureId+sourceDb', () => {
    const automationRows = new Map(loadDbRowsViaCli('automation').map((r) => [r.id, r]));
    const comfyRows = new Map(loadDbRowsViaCli('comfy-content-orchestrator').map((r) => [r.id, r]));

    if (automationRows.size === 0 && comfyRows.size === 0) {
      return;
    }

    for (const e of entries) {
      const row =
        e.sourceDb === 'automation' ? automationRows.get(e.failureId) : comfyRows.get(e.failureId);
      expect(row, `failureId=${e.failureId} (${e.sourceDb}) not found in DB`).toBeDefined();
      expect(row?.message).toBe(e.rawMessage);
    }
  });
});
