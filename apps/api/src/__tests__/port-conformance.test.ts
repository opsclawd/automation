import { describe, it, expectTypeOf } from 'vitest';
import type {
  RunRepositoryPort,
  EventRepositoryPort,
  FailureRepositoryPort,
  RunBashScriptFn,
} from '@ai-sdlc/application';
import {
  RunRepository,
  EventRepository,
  FailureRepository,
  runBashScript,
} from '@ai-sdlc/infrastructure';

describe('infrastructure adapters implement application ports', () => {
  it('RunRepository conforms to RunRepositoryPort', () => {
    expectTypeOf<RunRepository>().toMatchTypeOf<RunRepositoryPort>();
  });

  it('EventRepository conforms to EventRepositoryPort', () => {
    expectTypeOf<EventRepository>().toMatchTypeOf<EventRepositoryPort>();
  });

  it('FailureRepository conforms to FailureRepositoryPort', () => {
    expectTypeOf<FailureRepository>().toMatchTypeOf<FailureRepositoryPort>();
  });

  it('runBashScript conforms to RunBashScriptFn', () => {
    expectTypeOf<typeof runBashScript>().toMatchTypeOf<RunBashScriptFn>();
  });
});
