import { statfs, readFile } from 'node:fs/promises';
import os from 'node:os';
import type {
  EnvironmentHealthPort,
  EnvironmentHealthCheckResult,
} from '@ai-sdlc/application/ports';

export interface EnvironmentHealthAdapterOptions {
  tempDirectory?: string;
  minDiskFreeMb?: number;
  minMemoryAvailableMb?: number;
  readMeminfo?: () => Promise<string>;
  getStatfs?: (path: string) => Promise<{ bavail: bigint | number; bsize: bigint | number }>;
  getFreemem?: () => number;
}

export class EnvironmentHealthAdapter implements EnvironmentHealthPort {
  private readonly tempDirectory: string;
  private readonly minDiskFreeMb: number;
  private readonly minMemoryAvailableMb: number;
  private readonly readMeminfoFn: () => Promise<string>;
  private readonly getStatfsFn: (
    path: string,
  ) => Promise<{ bavail: bigint | number; bsize: bigint | number }>;
  private readonly getFreememFn: () => number;

  constructor(options?: EnvironmentHealthAdapterOptions) {
    this.tempDirectory = options?.tempDirectory ?? '/tmp';
    this.minDiskFreeMb = options?.minDiskFreeMb ?? 2048;
    this.minMemoryAvailableMb = options?.minMemoryAvailableMb ?? 4096;
    this.readMeminfoFn = options?.readMeminfo ?? (() => readFile('/proc/meminfo', 'utf-8'));
    this.getStatfsFn =
      options?.getStatfs ??
      (async (p: string) => {
        const s = await statfs(p);
        return { bavail: s.bavail, bsize: s.bsize };
      });
    this.getFreememFn = options?.getFreemem ?? (() => os.freemem());
  }

  async checkHealth(opts?: {
    minDiskFreeMb?: number;
    minMemoryAvailableMb?: number;
    targetPath?: string;
  }): Promise<EnvironmentHealthCheckResult> {
    const minDiskFreeMb = opts?.minDiskFreeMb ?? this.minDiskFreeMb;
    const minMemoryAvailableMb = opts?.minMemoryAvailableMb ?? this.minMemoryAvailableMb;
    const targetPath = opts?.targetPath ?? this.tempDirectory;
    const reasons: string[] = [];

    let diskFreeMb = 0;
    try {
      const stats = await this.getStatfsFn(targetPath);
      const freeBytes = BigInt(stats.bavail) * BigInt(stats.bsize);
      diskFreeMb = Number(freeBytes / BigInt(1024 * 1024));
      if (diskFreeMb < minDiskFreeMb) {
        reasons.push(
          `Disk free space in ${targetPath} is ${diskFreeMb} MB, below required ${minDiskFreeMb} MB`,
        );
      }
    } catch (err) {
      reasons.push(
        `Failed to check disk space in ${targetPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    let memoryAvailableMb = 0;
    try {
      const meminfo = await this.readMeminfoFn();
      const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
      if (match && match[1]) {
        memoryAvailableMb = Math.floor(parseInt(match[1], 10) / 1024);
      } else {
        memoryAvailableMb = Math.floor(this.getFreememFn() / (1024 * 1024));
      }
    } catch {
      memoryAvailableMb = Math.floor(this.getFreememFn() / (1024 * 1024));
    }

    if (memoryAvailableMb < minMemoryAvailableMb) {
      reasons.push(
        `Available memory is ${memoryAvailableMb} MB, below required ${minMemoryAvailableMb} MB`,
      );
    }

    return {
      healthy: reasons.length === 0,
      diskFreeMb,
      minDiskFreeMb,
      memoryAvailableMb,
      minMemoryAvailableMb,
      ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
    };
  }
}
