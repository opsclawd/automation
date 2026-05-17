import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Container } from './compose.js';
import { runsRoutes } from './routes/runs.js';
import { artifactsRoutes } from './routes/artifacts.js';

export interface ServerOptions {
  container: Container;
  port?: number;
}

export async function startServer(
  opts: ServerOptions,
): Promise<{ stop: () => Promise<void>; address: { port: number } }> {
  const app = Fastify({ logger: true, forceCloseConnections: 'idle' });
  await app.register(cors, { origin: ['http://127.0.0.1:4310'] });
  await runsRoutes(app, opts.container);
  await artifactsRoutes(app, opts.container);
  await app.listen({ port: opts.port ?? 4319, host: '127.0.0.1' });
  const address = app.server.address() as { port: number };
  return {
    stop: async () => {
      await app.close();
    },
    address,
  };
}
