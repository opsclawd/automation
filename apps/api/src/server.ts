import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Container } from './compose.js';
import { runsRoutes } from './routes/runs.js';
import { artifactsRoutes } from './routes/artifacts.js';

export interface ServerOptions {
  container: Container;
  port?: number;
}

export async function startServer(opts: ServerOptions): Promise<{ stop: () => Promise<void> }> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await runsRoutes(app, opts.container);
  await artifactsRoutes(app, opts.container);
  await app.listen({ port: opts.port ?? 4319, host: '127.0.0.1' });
  return {
    stop: async () => {
      await app.close();
    },
  };
}
