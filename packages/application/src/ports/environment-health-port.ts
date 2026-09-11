export interface EnvironmentHealthCheckResult {
  healthy: boolean;
  diskFreeMb: number;
  minDiskFreeMb: number;
  memoryAvailableMb: number;
  minMemoryAvailableMb: number;
  reason?: string | undefined;
}

export interface EnvironmentHealthPort {
  checkHealth(opts?: {
    minDiskFreeMb?: number;
    minMemoryAvailableMb?: number;
    targetPath?: string;
  }): Promise<EnvironmentHealthCheckResult>;
}
