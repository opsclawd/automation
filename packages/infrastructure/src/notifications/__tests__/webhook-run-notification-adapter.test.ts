import { describe, it, expect, vi } from 'vitest';
import { RepositoryId } from '@ai-sdlc/domain';
import type { LoggerPort } from '@ai-sdlc/application/ports';
import {
  WebhookRunNotificationAdapter,
  formatRunNotificationMessage,
} from '../webhook-run-notification-adapter.js';

describe('formatRunNotificationMessage', () => {
  it('formats terminal notification message without failureReason', () => {
    const msg = formatRunNotificationMessage({
      status: 'passed',
      repoId: RepositoryId('acme/widgets'),
      issueNumber: 42,
      displayId: 'run-1',
    });
    expect(msg).toBe('[passed] acme/widgets#42 (run-1)');
  });

  it('formats terminal notification message with failureReason', () => {
    const msg = formatRunNotificationMessage({
      status: 'failed',
      repoId: RepositoryId('acme/widgets'),
      issueNumber: 42,
      displayId: 'run-1',
      failureReason: 'test suite failed',
    });
    expect(msg).toBe('[failed] acme/widgets#42 (run-1): test suite failed');
  });
});

describe('WebhookRunNotificationAdapter', () => {
  const webhookUrl = 'https://ntfy.sh/test-topic';

  function makeLogger(): LoggerPort & { warnings: string[] } {
    const warnings: string[] = [];
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn((msg: string, ...args: unknown[]) => {
        warnings.push([msg, ...args.map(String)].join(' '));
      }),
      error: vi.fn(),
      warnings,
    };
  }

  it.each(['passed', 'failed', 'blocked', 'needs_human_review'] as const)(
    'posts formatted message to webhookUrl for status "%s"',
    async (status) => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
      const adapter = new WebhookRunNotificationAdapter(webhookUrl, undefined, fetchImpl);

      await adapter.notify({
        status,
        repoId: RepositoryId('org/repo'),
        issueNumber: 101,
        displayId: 'run-99',
        ...(status !== 'passed' ? { failureReason: `reason for ${status}` } : {}),
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchImpl.mock.calls[0];
      expect(calledUrl).toBe(webhookUrl);
      expect(init?.method).toBe('POST');
      if (status === 'passed') {
        expect(init?.body).toBe('[passed] org/repo#101 (run-99)');
      } else {
        expect(init?.body).toBe(`[${status}] org/repo#101 (run-99): reason for ${status}`);
      }
    },
  );

  it('catches non-2xx response, logs a warning, and does not throw', async () => {
    const logger = makeLogger();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('Internal Server Error', { status: 500 }));
    const adapter = new WebhookRunNotificationAdapter(webhookUrl, logger, fetchImpl);

    await expect(
      adapter.notify({
        status: 'failed',
        repoId: RepositoryId('org/repo'),
        issueNumber: 101,
        displayId: 'run-99',
        failureReason: 'boom',
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      'run notification webhook returned non-2xx status',
      'status=500',
    );
  });

  it('catches network rejection, logs a warning, and does not throw', async () => {
    const logger = makeLogger();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('Connection refused'));
    const adapter = new WebhookRunNotificationAdapter(webhookUrl, logger, fetchImpl);

    await expect(
      adapter.notify({
        status: 'failed',
        repoId: RepositoryId('org/repo'),
        issueNumber: 101,
        displayId: 'run-99',
        failureReason: 'boom',
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      'run notification webhook request failed',
      'Connection refused',
    );
  });

  it('handles non-2xx and network errors safely when logger is undefined', async () => {
    const fetchImplFail = vi.fn().mockResolvedValue(new Response('Error', { status: 404 }));
    const adapter1 = new WebhookRunNotificationAdapter(webhookUrl, undefined, fetchImplFail);

    await expect(
      adapter1.notify({
        status: 'passed',
        repoId: RepositoryId('org/repo'),
        issueNumber: 1,
        displayId: 'run-1',
      }),
    ).resolves.toBeUndefined();

    const fetchImplReject = vi.fn().mockRejectedValue(new Error('DNS failure'));
    const adapter2 = new WebhookRunNotificationAdapter(webhookUrl, undefined, fetchImplReject);

    await expect(
      adapter2.notify({
        status: 'passed',
        repoId: RepositoryId('org/repo'),
        issueNumber: 1,
        displayId: 'run-1',
      }),
    ).resolves.toBeUndefined();
  });

  it('catches and logs request timeout when fetch remains pending until signal aborts', async () => {
    const logger = makeLogger();
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'TimeoutError'));
        });
      });
    });

    const adapter = new WebhookRunNotificationAdapter(
      webhookUrl,
      logger,
      fetchImpl as unknown as typeof fetch,
      20,
    );

    await expect(
      adapter.notify({
        status: 'failed',
        repoId: RepositoryId('org/repo'),
        issueNumber: 101,
        displayId: 'run-99',
        failureReason: 'timeout test',
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      'run notification webhook request failed',
      expect.stringContaining('The operation was aborted'),
    );
  });

  describe('drain', () => {
    it('returns immediately when there are no pending notifications', async () => {
      const adapter = new WebhookRunNotificationAdapter(webhookUrl);
      await expect(adapter.drain(1000)).resolves.toBeUndefined();
    });

    it('awaits in-flight notifications before settling', async () => {
      let resolveFetch!: (res: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      const fetchImpl = vi.fn().mockReturnValue(fetchPromise);
      const adapter = new WebhookRunNotificationAdapter(webhookUrl, undefined, fetchImpl);

      let drained = false;
      const notifyPromise = adapter.notify({
        status: 'passed',
        repoId: RepositoryId('org/repo'),
        issueNumber: 1,
        displayId: 'run-1',
      });

      const drainPromise = adapter.drain(1000).then(() => {
        drained = true;
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(drained).toBe(false);

      resolveFetch(new Response('OK', { status: 200 }));
      await notifyPromise;
      await drainPromise;
      expect(drained).toBe(true);
    });

    it('settles within timeoutMs even if in-flight fetch never settles', async () => {
      const fetchImpl = vi.fn().mockReturnValue(new Promise(() => {}));
      const adapter = new WebhookRunNotificationAdapter(webhookUrl, undefined, fetchImpl, 60_000);

      // fire-and-forget
      void adapter.notify({
        status: 'passed',
        repoId: RepositoryId('org/repo'),
        issueNumber: 1,
        displayId: 'run-1',
      });

      const startTime = Date.now();
      await adapter.drain(50);
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(500);
    });

    it('waits for slow request timeout to settle and log before default drain resolves', async () => {
      const logger = makeLogger();
      const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'TimeoutError'));
          });
        });
      });

      const adapter = new WebhookRunNotificationAdapter(
        webhookUrl,
        logger,
        fetchImpl as unknown as typeof fetch,
        30,
      );

      void adapter.notify({
        status: 'failed',
        repoId: RepositoryId('org/repo'),
        issueNumber: 1,
        displayId: 'run-1',
        failureReason: 'timeout test',
      });

      await adapter.drain();

      expect(logger.warn).toHaveBeenCalledWith(
        'run notification webhook request failed',
        expect.stringContaining('The operation was aborted'),
      );
    });
  });
});
