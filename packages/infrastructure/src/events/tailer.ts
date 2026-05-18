import { promises as fs } from 'node:fs';
import { eventSchema, type OrchestratorEvent } from '@ai-sdlc/shared';

export interface EventTailerOptions {
  path: string;
  onEvent: (event: OrchestratorEvent) => void;
  onParseError?: (err: Error, line: string) => void;
  pollIntervalMs?: number;
}

export class EventTailer {
  private readonly path: string;
  private readonly onEvent: (e: OrchestratorEvent) => void;
  private readonly onParseError: ((err: Error, line: string) => void) | undefined;
  private readonly pollIntervalMs: number;
  private offset = 0;
  private lastMtimeMs = 0;
  private buffer = '';
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: EventTailerOptions) {
    this.path = opts.path;
    this.onEvent = opts.onEvent;
    this.onParseError = opts.onParseError;
    this.pollIntervalMs = opts.pollIntervalMs ?? 100;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.tick();
    this.scheduleTick();
  }

  private scheduleTick(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tick().finally(() => this.scheduleTick());
    }, this.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (stat.size < this.offset) {
      this.offset = 0;
      this.buffer = '';
    } else if (
      this.lastMtimeMs > 0 &&
      stat.mtimeMs > this.lastMtimeMs &&
      stat.size <= this.offset
    ) {
      this.offset = 0;
      this.buffer = '';
    }
    this.lastMtimeMs = stat.mtimeMs;
    if (stat.size === this.offset) return;
    const fh = await fs.open(this.path, 'r');
    try {
      const len = stat.size - this.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, this.offset);
      this.offset = stat.size;
      this.buffer += buf.toString('utf8');
      this.flushLines();
    } finally {
      await fh.close();
    }
  }

  private flushLines(): void {
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        this.onParseError?.(err as Error, line);
        continue;
      }
      const result = eventSchema.safeParse(parsed);
      if (!result.success) {
        this.onParseError?.(new Error(result.error.message), line);
        continue;
      }
      this.onEvent(result.data);
    }
  }

  async drainAndStop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
