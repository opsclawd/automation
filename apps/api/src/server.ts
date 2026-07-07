import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Container } from './compose.js';
import { runsRoutes } from './routes/runs.js';
import { artifactsRoutes } from './routes/artifacts.js';
import { eventsRoutes } from './routes/events.js';
import { registerInvocationsRoutes } from './routes/invocations.js';
import { registerValidationRoutes } from './routes/validation.js';
import { registerPrReviewRoutes } from './routes/pr-review.js';
import { registerReviewFixRoutes } from './routes/review-fix.js';
import { registerRepositoriesRoutes } from './routes/repositories.js';

export interface ServerOptions {
  container: Container;
  port?: number;
  // Test-only: destroy all sockets (including in-flight responses) on stop.
  // Production leaves this false so SIGINT/SIGTERM does not truncate artifact
  // downloads or future SSE streams; tests set it so afterEach does not block
  // on keep-alive sockets undici has not yet released.
  forceCloseAllOnStop?: boolean;
}

export async function buildServer(container: Container, logger: boolean = false) {
  const app = Fastify({ logger, forceCloseConnections: 'idle' });
  await app.register(cors, { origin: ['http://127.0.0.1:4310'] });
  await runsRoutes(app, container);
  await artifactsRoutes(app, container);
  await eventsRoutes(app, container);
  registerInvocationsRoutes(app, container);
  registerValidationRoutes(app, container);
  registerPrReviewRoutes(app, container);
  registerReviewFixRoutes(app, container);
  await registerRepositoriesRoutes(app, container);
  return app;
}

export async function startServer(
  opts: ServerOptions,
): Promise<{ stop: () => Promise<void>; address: { port: number } }> {
  const app = await buildServer(opts.container, true);
  await app.listen({ port: opts.port ?? 4319, host: '127.0.0.1' });
  const address = app.server.address() as { port: number };
  return {
    stop: async () => {
      if (opts.forceCloseAllOnStop) app.server.closeAllConnections();
      await app.close();
    },
    address,
  };
}
