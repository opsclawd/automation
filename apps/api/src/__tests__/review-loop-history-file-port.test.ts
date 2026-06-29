import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { createReviewLoopHistoryFilePort } from '../review-loop-history-file-port.js';
import type { StepContext, ReviewLoopHistoryEntry, EventBusPort } from '@ai-sdlc/application';
import type { PhaseName, RunId } from '@ai-sdlc/domain';

describe('createReviewLoopHistoryFilePort', () => {
  let tempDir: string;
  let ctx: StepContext;
  let mockEventBus: {
    publish: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'review-loop-history-test-'));
    ctx = {
      loopId: 'loop-1',
      runId: 'run-1' as unknown as RunId,
      phaseId: 'review-fix' as unknown as PhaseName,
      repoId: 'repo-1',
      cwd: tempDir,
      iterationIndex: 1,
    };
    mockEventBus = {
      publish: vi.fn(),
      subscribe: vi.fn(),
    };
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('read returns [] when the file is missing', async () => {
    const port = createReviewLoopHistoryFilePort(mockEventBus as unknown as EventBusPort);
    const result = await port.read(ctx);
    expect(result).toEqual([]);
    expect(mockEventBus.publish).not.toHaveBeenCalled();
  });

  it('read returns parsed entries when the file exists and is valid', async () => {
    const port = createReviewLoopHistoryFilePort(mockEventBus as unknown as EventBusPort);
    const entries: ReviewLoopHistoryEntry[] = [
      {
        iteration: 1,
        review: { verdict: 'fail', offendingFindings: [{ severity: 'high', summary: 'bug' }] },
        outcome: 'failed',
      },
    ];
    writeFileSync(
      join(tempDir, 'review-loop-history.json'),
      JSON.stringify(entries, null, 2),
      'utf-8',
    );

    const result = await port.read(ctx);
    expect(result).toEqual(entries);
    expect(mockEventBus.publish).not.toHaveBeenCalled();
  });

  it('read returns [] and publishes warning when file content is not an array', async () => {
    const port = createReviewLoopHistoryFilePort(mockEventBus as unknown as EventBusPort);
    const invalidData = { not: 'an array' };
    writeFileSync(join(tempDir, 'review-loop-history.json'), JSON.stringify(invalidData), 'utf-8');

    const result = await port.read(ctx);
    expect(result).toEqual([]);
    expect(mockEventBus.publish).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        runId: 'run-1',
        phase: 'review-fix',
        level: 'warn',
        type: 'review_loop_history.read_failed',
        message: expect.stringContaining('Parsed JSON is not an array'),
        metadata: expect.objectContaining({
          iterationIndex: 1,
          error: 'Parsed JSON is not an array',
        }),
      }),
    );
  });

  it('read returns [] and publishes warning when JSON is malformed', async () => {
    const port = createReviewLoopHistoryFilePort(mockEventBus as unknown as EventBusPort);
    writeFileSync(join(tempDir, 'review-loop-history.json'), '{invalid json', 'utf-8');

    const result = await port.read(ctx);
    expect(result).toEqual([]);
    expect(mockEventBus.publish).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        runId: 'run-1',
        phase: 'review-fix',
        level: 'warn',
        type: 'review_loop_history.read_failed',
        metadata: expect.objectContaining({
          iterationIndex: 1,
          error: expect.any(String),
        }),
      }),
    );
  });

  it('append successfully writes entry and preserves existing entries', async () => {
    const port = createReviewLoopHistoryFilePort(mockEventBus as unknown as EventBusPort);
    const entry1: ReviewLoopHistoryEntry = {
      iteration: 1,
      review: { verdict: 'fail' },
      outcome: 'failed',
    };
    const entry2: ReviewLoopHistoryEntry = {
      iteration: 2,
      review: { verdict: 'pass' },
      outcome: 'resolved',
    };

    // First append to a missing file
    await port.append(ctx, entry1);

    let currentData = JSON.parse(readFileSync(join(tempDir, 'review-loop-history.json'), 'utf-8'));
    expect(currentData).toEqual([entry1]);

    // Second append preserving existing
    ctx.iterationIndex = 2;
    await port.append(ctx, entry2);

    currentData = JSON.parse(readFileSync(join(tempDir, 'review-loop-history.json'), 'utf-8'));
    expect(currentData).toEqual([entry1, entry2]);
    expect(mockEventBus.publish).not.toHaveBeenCalled();
  });

  it('append tolerates malformed existing history by starting with empty entries and warning', async () => {
    const port = createReviewLoopHistoryFilePort(mockEventBus as unknown as EventBusPort);
    writeFileSync(join(tempDir, 'review-loop-history.json'), '{invalid json', 'utf-8');

    const entry: ReviewLoopHistoryEntry = {
      iteration: 1,
      review: { verdict: 'pass' },
      outcome: 'resolved',
    };

    await port.append(ctx, entry);

    // Verify file contains only the new entry
    const currentData = JSON.parse(
      readFileSync(join(tempDir, 'review-loop-history.json'), 'utf-8'),
    );
    expect(currentData).toEqual([entry]);
    expect(mockEventBus.publish).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        runId: 'run-1',
        phase: 'review-fix',
        level: 'warn',
        type: 'review_loop_history.read_failed',
      }),
    );
  });

  it('format delegates to formatReviewLoopHistoryForPrompt', () => {
    const port = createReviewLoopHistoryFilePort(mockEventBus as unknown as EventBusPort);
    const history: ReviewLoopHistoryEntry[] = [
      {
        iteration: 1,
        review: { verdict: 'fail' },
        outcome: 'failed',
      },
    ];
    const formatted = port.format(history, 'reviewer');
    expect(formatted).toContain('Iteration 1');
    expect(formatted).toContain('Outcome: failed');
  });
});
