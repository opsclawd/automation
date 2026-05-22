import type {
  RunRepositoryPort,
  EventRepositoryPort,
  FailureRepositoryPort,
  AgentInvocationPort,
  RunBashScriptFn,
} from '@ai-sdlc/application';
import type {
  RunRepository,
  EventRepository,
  FailureRepository,
  AgentInvocationRepository,
} from '@ai-sdlc/infrastructure';
import type { runBashScript } from '@ai-sdlc/infrastructure';

// Type-level conformance assertions — each assigns the adapter type to the
// port type. If structural typing diverges, tsc --noEmit will error here.
// Unlike expectTypeOf in vitest tests (stripped by esbuild), these are
// checked by `pnpm -r typecheck` because this file is included in tsconfig.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _runRepository: RunRepositoryPort = null as unknown as RunRepository;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _eventRepository: EventRepositoryPort = null as unknown as EventRepository;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _failureRepository: FailureRepositoryPort = null as unknown as FailureRepository;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _runBashScript: RunBashScriptFn = null as unknown as typeof runBashScript;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _agentInvocationRepo: AgentInvocationPort = null as unknown as AgentInvocationRepository;
