import type { RepositoryDto } from './api-client';

export interface AvailabilityResult {
  label: string;
  reason: string | null;
  eligible: boolean;
}

export function getRepositoryAvailability(repository: RepositoryDto): AvailabilityResult {
  if (!repository.enabled) {
    return {
      label: 'Disabled',
      reason: 'Repository is disabled',
      eligible: false,
    };
  }

  switch (repository.healthStatus) {
    case 'unknown':
      return {
        label: 'Unknown',
        reason: repository.healthError || 'Health check pending',
        eligible: false,
      };
    case 'degraded':
      return {
        label: 'Degraded',
        reason: repository.healthError || 'Repository health is degraded',
        eligible: false,
      };
    case 'unreachable':
      return {
        label: 'Unreachable',
        reason: repository.healthError || 'Repository is unreachable',
        eligible: false,
      };
    case 'healthy':
      return {
        label: 'Healthy',
        reason: null,
        eligible: true,
      };
    default:
      return {
        label: 'Unknown',
        reason: 'Unknown health status',
        eligible: false,
      };
  }
}
