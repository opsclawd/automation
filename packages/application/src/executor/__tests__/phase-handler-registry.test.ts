import { describe, it, expect } from 'vitest';
import { PhaseName } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../../phases/handler.js';
import { PhaseHandlerRegistry, UnregisteredPhaseError } from '../phase-handler-registry.js';

function makeStubHandler(phase: string, outcome: 'passed' | 'failed' = 'passed'): PhaseHandler {
  return {
    phase: PhaseName(phase),
    run: async (_ctx: PhaseHandlerContext): Promise<PhaseResult> => {
      return { outcome };
    },
  };
}

describe('PhaseHandlerRegistry', () => {
  it('get() returns the registered handler for a given phase', () => {
    const registry = new PhaseHandlerRegistry();
    const handler = makeStubHandler('read_issue');
    registry.register(handler);
    expect(registry.get(PhaseName('read_issue'))).toBe(handler);
  });

  it('get() throws UnregisteredPhaseError for unregistered phases', () => {
    const registry = new PhaseHandlerRegistry();
    expect(() => registry.get(PhaseName('read_issue'))).toThrow(UnregisteredPhaseError);
    expect(() => registry.get(PhaseName('read_issue'))).toThrow(
      "no PhaseHandler registered for 'PhaseName(read_issue)'",
    );
  });

  it('register() overwrites an existing handler (last-register-wins)', () => {
    const registry = new PhaseHandlerRegistry();
    const first = makeStubHandler('read_issue');
    const second = makeStubHandler('read_issue', 'failed');
    registry.register(first);
    registry.register(second);
    expect(registry.get(PhaseName('read_issue'))).toBe(second);
  });

  it('multiple handlers can be registered and retrieved independently', () => {
    const registry = new PhaseHandlerRegistry();
    const readIssue = makeStubHandler('read_issue');
    const planDesign = makeStubHandler('plan-design');
    const implement = makeStubHandler('implement');
    registry.register(readIssue);
    registry.register(planDesign);
    registry.register(implement);
    expect(registry.get(PhaseName('read_issue'))).toBe(readIssue);
    expect(registry.get(PhaseName('plan-design'))).toBe(planDesign);
    expect(registry.get(PhaseName('implement'))).toBe(implement);
  });
});
