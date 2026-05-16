import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, normalize, relative, isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../compose.js';

interface FileEntry {
  path: string;
  size: number;
  modifiedAt: string;
}

function walk(root: string, prefix = ''): FileEntry[] {
  const out: FileEntry[] = [];
  for (const name of readdirSync(root)) {
    const abs = join(root, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      out.push(...walk(abs, rel));
    } else {
      out.push({ path: rel, size: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function artifactsRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/artifacts', async (req, reply) => {
    const run = c.runRepository.findByUuid(req.params.runId);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    const root = join(c.runsDir, run.displayId);
    try {
      return { files: walk(root) };
    } catch {
      return { files: [] };
    }
  });

  app.get<{ Params: { runId: string; '*': string } }>(
    '/api/runs/:runId/artifacts/*',
    async (req, reply) => {
      const run = c.runRepository.findByUuid(req.params.runId);
      if (!run) return reply.code(404).send({ error: 'not_found' });
      const root = join(c.runsDir, run.displayId);
      const requested = normalize(req.params['*']);
      if (requested.startsWith('..') || isAbsolute(requested)) {
        return reply.code(400).send({ error: 'invalid_path' });
      }
      const abs = join(root, requested);
      if (relative(root, abs).startsWith('..')) {
        return reply.code(400).send({ error: 'invalid_path' });
      }
      try {
        const buf = readFileSync(abs);
        reply.header('content-type', guessType(abs));
        return reply.send(buf);
      } catch {
        return reply.code(404).send({ error: 'not_found' });
      }
    },
  );
}

function guessType(path: string): string {
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.md')) return 'text/markdown';
  if (path.endsWith('.log') || path.endsWith('.txt') || path.endsWith('.diff')) return 'text/plain';
  return 'application/octet-stream';
}
