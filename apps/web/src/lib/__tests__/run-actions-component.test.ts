import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunActions } from '../../components/RunActions';
import * as apiClient from '../api-client';
import type { RunDto } from '../api-client';

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: mockRefresh,
  }),
}));

vi.mock('../api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api-client')>();
  return {
    ...actual,
    cancelRunAction: vi.fn(),
    retryRunAction: vi.fn(),
    resumeRunAction: vi.fn(),
  };
});

describe('RunActions component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseRun: RunDto = {
    uuid: 'uuid-456',
    displayId: 'R-456',
    issueNumber: 42,
    repoId: 'repo-xyz',
    status: 'needs_human_review',
    currentPhase: 'implement',
    completedPhases: ['read_issue', 'plan-design', 'plan-write'],
    startedAt: '2026-08-16T12:00:00Z',
    completedAt: null,
    exitCode: null,
    durationMs: null,
    failureReason: null,
  };

  describe('rendering recovery controls', () => {
    it('renders Resume, Retry phase, and Cancel controls when status is needs_human_review', () => {
      const run: RunDto = { ...baseRun, status: 'needs_human_review' };
      const html = renderToStaticMarkup(
        React.createElement(RunActions, { repositoryId: 'repo-xyz', run }),
      );

      expect(html).toContain('Resume');
      expect(html).toContain('Retry phase');
      expect(html).toContain('Cancel');
      expect(html).toContain('Automatic (failed or blocked step)');
      expect(html).toContain('implement');
      expect(html).toContain('validate');
    });

    it('renders Resume and Retry phase controls but NOT Cancel when status is failed', () => {
      const run: RunDto = { ...baseRun, status: 'failed' };
      const html = renderToStaticMarkup(
        React.createElement(RunActions, { repositoryId: 'repo-xyz', run }),
      );

      expect(html).toContain('Resume');
      expect(html).toContain('Retry phase');
      expect(html).not.toContain('Cancel');
    });

    it('renders Resume and Retry phase controls and Cancel when status is blocked', () => {
      const run: RunDto = { ...baseRun, status: 'blocked' };
      const html = renderToStaticMarkup(
        React.createElement(RunActions, { repositoryId: 'repo-xyz', run }),
      );

      expect(html).toContain('Resume');
      expect(html).toContain('Retry phase');
      expect(html).toContain('Cancel');
    });

    it('renders only Cancel button when status is running', () => {
      const run: RunDto = { ...baseRun, status: 'running' as RunDto['status'] };
      const html = renderToStaticMarkup(
        React.createElement(RunActions, { repositoryId: 'repo-xyz', run }),
      );

      expect(html).toContain('Cancel');
      expect(html).not.toContain('Resume');
      expect(html).not.toContain('Retry phase');
    });

    it('renders nothing when status is passed or cancelled', () => {
      const passedHtml = renderToStaticMarkup(
        React.createElement(RunActions, {
          repositoryId: 'repo-xyz',
          run: { ...baseRun, status: 'passed' },
        }),
      );
      expect(passedHtml).toBe('');

      const cancelledHtml = renderToStaticMarkup(
        React.createElement(RunActions, {
          repositoryId: 'repo-xyz',
          run: { ...baseRun, status: 'cancelled' },
        }),
      );
      expect(cancelledHtml).toBe('');
    });
  });

  describe('invoking client recovery actions for needs_human_review', () => {
    type Dispatcher = {
      useState: (init: unknown) => [unknown, (val: unknown) => void];
    };
    type ReactInternals = {
      ReactCurrentDispatcher?: {
        current: Dispatcher | null;
      };
    };

    function renderComponentElements(run: RunDto, selectedPhaseValue = '') {
      const stateStore = new Map<number, [unknown, (v: unknown) => void]>();
      let hookIndex = 0;

      const initialValues: unknown[] = [
        false, // isLoading
        selectedPhaseValue, // selectedPhase
        false, // showDialog
        null, // dialogPayload
        null, // error
      ];

      const dispatcher: Dispatcher = {
        useState: (init: unknown) => {
          const idx = hookIndex++;
          if (!stateStore.has(idx)) {
            const initial = initialValues[idx] !== undefined ? initialValues[idx] : init;
            const setter = vi.fn((newVal: unknown) => {
              const current = stateStore.get(idx);
              if (current) {
                current[0] =
                  typeof newVal === 'function'
                    ? (newVal as (prev: unknown) => unknown)(current[0])
                    : newVal;
              }
            });
            stateStore.set(idx, [initial, setter]);
          }
          return stateStore.get(idx)!;
        },
      };

      const internals = (
        React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?: ReactInternals }
      ).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

      const prevDispatcher = internals?.ReactCurrentDispatcher?.current ?? null;
      if (internals?.ReactCurrentDispatcher) {
        internals.ReactCurrentDispatcher.current = dispatcher;
      }

      try {
        const tree = RunActions({ repositoryId: 'repo-xyz', run });
        return { tree, stateStore };
      } finally {
        if (internals?.ReactCurrentDispatcher) {
          internals.ReactCurrentDispatcher.current = prevDispatcher;
        }
      }
    }

    function extractButtons(tree: React.ReactElement | null) {
      if (!tree) {
        return { cancelButton: undefined, resumeButton: undefined, retryButton: undefined };
      }
      const container = tree.props.children[0];
      const children = React.Children.toArray(container.props.children);

      let cancelButton: React.ReactElement | undefined;
      let resumeButton: React.ReactElement | undefined;
      let retryButton: React.ReactElement | undefined;

      for (const child of children) {
        if (!child || typeof child !== 'object' || !('props' in child)) continue;
        const elem = child as React.ReactElement;
        if (elem.type === 'button' && elem.props.children === 'Cancel') {
          cancelButton = elem;
        } else if (elem.type === React.Fragment) {
          const fragChildren = React.Children.toArray(elem.props.children);
          for (const fc of fragChildren) {
            if (!fc || typeof fc !== 'object' || !('props' in fc)) continue;
            const fe = fc as React.ReactElement;
            if (fe.type === 'button' && fe.props.children === 'Resume') {
              resumeButton = fe;
            } else if (fe.type === 'button' && fe.props.children === 'Retry phase') {
              retryButton = fe;
            }
          }
        }
      }

      return { cancelButton, resumeButton, retryButton };
    }

    it('invokes resumeRunAction and refreshes when Resume is clicked for needs_human_review', async () => {
      const run: RunDto = { ...baseRun, status: 'needs_human_review' };
      vi.mocked(apiClient.resumeRunAction).mockResolvedValue({
        run,
        action: 'resume',
        targetPhase: 'implement',
        requiresConfirmation: false,
      });

      const { tree } = renderComponentElements(run);
      const { resumeButton } = extractButtons(tree);

      expect(resumeButton).toBeDefined();
      await resumeButton!.props.onClick();

      expect(apiClient.resumeRunAction).toHaveBeenCalledWith('repo-xyz', 'uuid-456', {});
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('invokes resumeRunAction with selected phase when phase is selected', async () => {
      const run: RunDto = { ...baseRun, status: 'needs_human_review' };
      vi.mocked(apiClient.resumeRunAction).mockResolvedValue({
        run,
        action: 'resume',
        targetPhase: 'implement',
        requiresConfirmation: false,
      });

      const { tree } = renderComponentElements(run, 'implement');
      const { resumeButton } = extractButtons(tree);

      expect(resumeButton).toBeDefined();
      await resumeButton!.props.onClick();

      expect(apiClient.resumeRunAction).toHaveBeenCalledWith('repo-xyz', 'uuid-456', {
        fromPhase: 'implement',
      });
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('invokes retryRunAction and refreshes when Retry phase is clicked for needs_human_review', async () => {
      const run: RunDto = { ...baseRun, status: 'needs_human_review' };
      vi.mocked(apiClient.retryRunAction).mockResolvedValue({
        run,
        action: 'retry',
        targetPhase: 'implement',
        requiresConfirmation: false,
      });

      const { tree } = renderComponentElements(run);
      const { retryButton } = extractButtons(tree);

      expect(retryButton).toBeDefined();
      await retryButton!.props.onClick();

      expect(apiClient.retryRunAction).toHaveBeenCalledWith('repo-xyz', 'uuid-456');
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('invokes cancelRunAction and refreshes when Cancel is clicked for needs_human_review', async () => {
      const run: RunDto = { ...baseRun, status: 'needs_human_review' };
      vi.mocked(apiClient.cancelRunAction).mockResolvedValue({
        run,
        action: 'cancel' as const,
        requiresConfirmation: false,
      });

      const { tree } = renderComponentElements(run);
      const { cancelButton } = extractButtons(tree);

      expect(cancelButton).toBeDefined();
      await cancelButton!.props.onClick();

      expect(apiClient.cancelRunAction).toHaveBeenCalledWith('repo-xyz', 'uuid-456');
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
  });
});
