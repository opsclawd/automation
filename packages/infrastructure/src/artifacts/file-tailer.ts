import { promises as fs } from 'node:fs';
import type { FileTailerOptions, FileTailerPort } from '@ai-sdlc/application/ports';

export class FileTailer implements FileTailerPort {
  private readonly path: string;
  private readonly onData: (data: string) => void;
  private readonly pollIntervalMs: number;
  private readonly initialLines: number | undefined;
  private readonly fromStart: boolean | undefined;
  private offset = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private tickInProgress: Promise<void> | null = null;

  constructor(opts: FileTailerOptions) {
    this.path = opts.path;
    this.onData = opts.onData;
    this.pollIntervalMs = opts.pollIntervalMs ?? 100;
    this.initialLines = opts.initialLines;
    this.fromStart = opts.fromStart;
  }

  async start(): Promise<void> {
    this.running = true;

    try {
      const stat = await fs.stat(this.path);
      if (this.initialLines !== undefined && this.initialLines > 0) {
        await this.readInitialLines(stat.size);
      } else if (this.fromStart) {
        this.offset = 0;
      } else {
        this.offset = stat.size;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      // File doesn't exist yet, start from offset 0
      this.offset = 0;
    }

    await this.tick();
    this.scheduleTick();
  }

  private async readInitialLines(fileSize: number): Promise<void> {
    if (fileSize === 0) {
      this.offset = 0;
      return;
    }

    // Heuristic: assume average line length is 1000 chars to be safe.
    const bytesToRead = Math.min(fileSize, (this.initialLines ?? 0) * 1000);
    const startPos = fileSize - bytesToRead;

    const fh = await fs.open(this.path, 'r');
    try {
      const buf = Buffer.alloc(bytesToRead);
      const { bytesRead } = await fh.read(buf, 0, bytesToRead, startPos);
      const content = buf.toString('utf8', 0, bytesRead);
      let lines = content.split('\n');

      // If the file ends with a newline, the last element is empty.
      // We want N lines before that.
      if (content.endsWith('\n')) {
        lines = lines.slice(0, -1);
      }

      const lastLines = lines.slice(-(this.initialLines ?? 0));
      const tailContent = lastLines.join('\n');
      if (tailContent) {
        this.onData(tailContent + '\n');
      }
      this.offset = fileSize;
    } finally {
      await fh.close();
    }
  }

  private scheduleTick(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      if (!this.running) return;
      this.tickInProgress = this.tick().finally(() => {
        this.tickInProgress = null;
        this.scheduleTick();
      });
    }, this.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    try {
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(this.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }

      if (stat.size < this.offset) {
        // File truncated
        this.offset = 0;
      }

      if (stat.size === this.offset) return;

      const fh = await fs.open(this.path, 'r');
      try {
        const len = stat.size - this.offset;
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, this.offset);
        if (bytesRead > 0) {
          const data = buf.toString('utf8', 0, bytesRead);
          this.onData(data);
          this.offset += bytesRead;
        }
      } finally {
        await fh.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`FileTailer error tailing ${this.path}:`, err);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.tickInProgress) {
      await this.tickInProgress;
    }
  }
}
