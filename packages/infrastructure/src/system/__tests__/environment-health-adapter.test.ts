import { describe, it, expect } from 'vitest';
import { EnvironmentHealthAdapter } from '../environment-health-adapter.js';

describe('EnvironmentHealthAdapter', () => {
  it('reports healthy when disk and memory exceed thresholds', async () => {
    const adapter = new EnvironmentHealthAdapter({
      minDiskFreeMb: 2048,
      minMemoryAvailableMb: 4096,
      getStatfs: async () => ({
        bavail: 1024 * 1024 * 5, // 5GB in 1KB blocks
        bsize: 1024,
      }),
      readMeminfo: async () => 'MemTotal: 16000000 kB\nMemAvailable: 8000000 kB\n',
    });

    const result = await adapter.checkHealth();
    expect(result.healthy).toBe(true);
    expect(result.diskFreeMb).toBe(5120);
    expect(result.memoryAvailableMb).toBeGreaterThan(7000);
    expect(result.reason).toBeUndefined();
  });

  it('reports unhealthy when disk free space is below threshold', async () => {
    const adapter = new EnvironmentHealthAdapter({
      minDiskFreeMb: 2048,
      minMemoryAvailableMb: 4096,
      getStatfs: async () => ({
        bavail: 1024 * 1024 * 1, // 1GB in 1KB blocks
        bsize: 1024,
      }),
      readMeminfo: async () => 'MemTotal: 16000000 kB\nMemAvailable: 8000000 kB\n',
    });

    const result = await adapter.checkHealth();
    expect(result.healthy).toBe(false);
    expect(result.diskFreeMb).toBe(1024);
    expect(result.reason).toContain('Disk free space in /tmp is 1024 MB, below required 2048 MB');
  });

  it('reports unhealthy when memory available is below threshold', async () => {
    const adapter = new EnvironmentHealthAdapter({
      minDiskFreeMb: 2048,
      minMemoryAvailableMb: 4096,
      getStatfs: async () => ({
        bavail: 1024 * 1024 * 10,
        bsize: 1024,
      }),
      readMeminfo: async () => 'MemTotal: 16000000 kB\nMemAvailable: 2000000 kB\n',
    });

    const result = await adapter.checkHealth();
    expect(result.healthy).toBe(false);
    expect(result.memoryAvailableMb).toBeLessThan(4000);
    expect(result.reason).toContain('Available memory is');
  });

  it('falls back to os.freemem when meminfo is unavailable', async () => {
    const adapter = new EnvironmentHealthAdapter({
      minDiskFreeMb: 2048,
      minMemoryAvailableMb: 4096,
      getStatfs: async () => ({
        bavail: 1024 * 1024 * 5,
        bsize: 1024,
      }),
      readMeminfo: async () => {
        throw new Error('ENOENT');
      },
      getFreemem: () => 6 * 1024 * 1024 * 1024, // 6 GB
    });

    const result = await adapter.checkHealth();
    expect(result.healthy).toBe(true);
    expect(result.memoryAvailableMb).toBe(6144);
  });
});
