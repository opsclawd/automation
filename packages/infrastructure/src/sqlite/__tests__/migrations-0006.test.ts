import { describe, it, expect } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';

describe('migration 0006 pr-review', () => {
  it('creates pr_review_comments, pr_review_replies, poll_attempts', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: { name: string }) => r.name);
    expect(tables).toContain('pr_review_comments');
    expect(tables).toContain('pr_review_replies');
    expect(tables).toContain('poll_attempts');
    db.close();
  });

  it('is idempotent', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
    db.close();
  });

  it('creates expected indexes', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r: { name: string }) => r.name);
    expect(indexes).toContain('idx_pr_review_comments_run');
    expect(indexes).toContain('idx_pr_review_replies_run');
    expect(indexes).toContain('idx_poll_attempts_run');
    db.close();
  });
});
