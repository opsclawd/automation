import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { FileTailer } from '../file-tailer.js';

function tempFilePath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'file-tailer-'));
  return { dir, path: join(dir, 'stdout.log') };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

describe('FileTailer', () => {
  it('starts from EOF by default and only emits newly appended data', async () => {
    const { dir, path } = tempFilePath();
    try {
      writeFileSync(path, 'line1\nline2\n');
      const chunks: string[] = [];
      const tailer = new FileTailer({ path, onData: (d) => chunks.push(d), pollIntervalMs: 20 });
      await tailer.start();
      expect(chunks.join('')).toBe('');

      appendFileSync(path, 'line3\n');
      await waitFor(() => chunks.join('').includes('line3'));
      expect(chunks.join('')).toBe('line3\n');

      await tailer.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads from the beginning when fromStart is true', async () => {
    const { dir, path } = tempFilePath();
    try {
      writeFileSync(path, 'line1\nline2\n');
      const chunks: string[] = [];
      const tailer = new FileTailer({
        path,
        onData: (d) => chunks.push(d),
        pollIntervalMs: 20,
        fromStart: true,
      });
      await tailer.start();
      expect(chunks.join('')).toBe('line1\nline2\n');
      await tailer.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits only the last N lines when initialLines is set', async () => {
    const { dir, path } = tempFilePath();
    try {
      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
      writeFileSync(path, lines.join('\n') + '\n');
      const chunks: string[] = [];
      const tailer = new FileTailer({
        path,
        onData: (d) => chunks.push(d),
        pollIntervalMs: 20,
        initialLines: 3,
      });
      await tailer.start();
      expect(chunks.join('').trim().split('\n')).toEqual(['line7', 'line8', 'line9']);
      await tailer.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not emit anything for initialLines when the file is empty', async () => {
    const { dir, path } = tempFilePath();
    try {
      writeFileSync(path, '');
      const chunks: string[] = [];
      const tailer = new FileTailer({
        path,
        onData: (d) => chunks.push(d),
        pollIntervalMs: 20,
        initialLines: 5,
      });
      await tailer.start();
      expect(chunks.join('')).toBe('');
      await tailer.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads correct last N lines when a single line far exceeds the 1000-char/line heuristic', async () => {
    // Regression test: readInitialLines estimates bytesToRead as
    // initialLines * 1000. A single line longer than that would previously
    // start reading mid-line, corrupting the "last N lines" output.
    const { dir, path } = tempFilePath();
    try {
      const longLine = 'x'.repeat(5000);
      const content = `short1\nshort2\n${longLine}\n`;
      writeFileSync(path, content);
      const chunks: string[] = [];
      const tailer = new FileTailer({
        path,
        onData: (d) => chunks.push(d),
        pollIntervalMs: 20,
        initialLines: 3,
      });
      await tailer.start();
      const emitted = chunks.join('').trim().split('\n');
      expect(emitted).toEqual(['short1', 'short2', longLine]);
      await tailer.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resets to the start when the file is truncated', async () => {
    const { dir, path } = tempFilePath();
    try {
      writeFileSync(path, 'aaaaaaaaaa\n');
      const chunks: string[] = [];
      const tailer = new FileTailer({
        path,
        onData: (d) => chunks.push(d),
        pollIntervalMs: 20,
        fromStart: true,
      });
      await tailer.start();
      await waitFor(() => chunks.join('').includes('aaaaaaaaaa'));
      chunks.length = 0;

      // Truncate to something shorter than the previous offset.
      writeFileSync(path, 'b\n');
      await waitFor(() => chunks.join('').includes('b'));
      expect(chunks.join('')).toBe('b\n');

      await tailer.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts at offset 0 and picks up content once a not-yet-existing file is created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'file-tailer-'));
    const path = join(dir, 'stdout.log');
    try {
      const chunks: string[] = [];
      const tailer = new FileTailer({ path, onData: (d) => chunks.push(d), pollIntervalMs: 20 });
      await tailer.start();
      expect(chunks.join('')).toBe('');

      writeFileSync(path, 'hello\n');
      await waitFor(() => chunks.join('').includes('hello'));
      expect(chunks.join('')).toBe('hello\n');

      await tailer.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stop() halts polling so no further onData calls occur', async () => {
    const { dir, path } = tempFilePath();
    try {
      writeFileSync(path, '');
      const chunks: string[] = [];
      const tailer = new FileTailer({ path, onData: (d) => chunks.push(d), pollIntervalMs: 20 });
      await tailer.start();
      await tailer.stop();

      appendFileSync(path, 'should not appear\n');
      await sleep(100);
      expect(chunks.join('')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
