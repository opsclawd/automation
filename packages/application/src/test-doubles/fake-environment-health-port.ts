import type {
  EnvironmentHealthPort,
  EnvironmentHealthCheckResult,
} from '../ports/environment-health-port.js';

export class FakeEnvironmentHealthPort implements EnvironmentHealthPort {
  diskFreeMb = 10_000;
  memoryAvailableMb = 16_000;
  shouldFail = false;
  failureReason = 'Simulated environment failure';
  checkCalls: Array<{
    minDiskFreeMb?: number;
    minMemoryAvailableMb?: number;
    targetPath?: string;
  }> = [];

  async checkHealth(opts?: {
    minDiskFreeMb?: number;
    minMemoryAvailableMb?: number;
    targetPath?: string;
  }): Promise<EnvironmentHealthCheckResult> {
    this.checkCalls.push(opts ?? {});
    const minDisk = opts?.minDiskFreeMb ?? 2048;
    const minMem = opts?.minMemoryAvailableMb ?? 4096;

    if (this.shouldFail) {
      return {
        healthy: false,
        diskFreeMb: this.diskFreeMb,
        minDiskFreeMb: minDisk,
        memoryAvailableMb: this.memoryAvailableMb,
        minMemoryAvailableMb: minMem,
        reason: this.failureReason,
      };
    }

    const diskOk = this.diskFreeMb >= minDisk;
    const memOk = this.memoryAvailableMb >= minMem;
    const healthy = diskOk && memOk;

    let reason: string | undefined;
    if (!diskOk) {
      reason = `Disk free space (${this.diskFreeMb}MB) is below required floor (${minDisk}MB)`;
    } else if (!memOk) {
      reason = `Available memory (${this.memoryAvailableMb}MB) is below required floor (${minMem}MB)`;
    }

    return {
      healthy,
      diskFreeMb: this.diskFreeMb,
      minDiskFreeMb: minDisk,
      memoryAvailableMb: this.memoryAvailableMb,
      minMemoryAvailableMb: minMem,
      ...(reason !== undefined ? { reason } : {}),
    };
  }
}
