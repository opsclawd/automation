import { describe, it, expect, vi } from 'vitest';
import { RepositoryId } from '@ai-sdlc/domain';
import { NoopRunNotificationAdapter } from '../noop-run-notification-adapter.js';

describe('NoopRunNotificationAdapter', () => {
  it('resolves without error and makes no network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const adapter = new NoopRunNotificationAdapter();

    await expect(
      adapter.notify({
        status: 'passed',
        repoId: RepositoryId('acme/widgets'),
        issueNumber: 42,
        displayId: 'run-1',
      }),
    ).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
