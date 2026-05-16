import { readdir, stat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, normalize, relative, isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../compose.js';

interface FileEntry {
  path: string;
  size: number;
  modifiedAt: string;
}

async function walk(root: string, prefix = ''): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const dirent of entries) {
    const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    const abs = join(root, dirent.name);
    if (dirent.isDirectory()) {
      const resolvedRoot = await realpath(root);
      const resolvedAbs = await realpath(abs).catch(() => null);
      if (resolvedAbs && !resolvedAbs.startsWith(resolvedRoot)) continue;
      out.push(...(await walk(abs, rel)));
    } else if (dirent.isFile()) {
      const s = await stat(abs);
      out.push({ path: rel, size: s.size, modifiedAt: s.mtime.toISOString() });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function artifactsRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/artifacts', async (req, reply) => {
    if (!UUID_RE.test(req.params.runId)) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    const run = c.runRepository.findByUuid(req.params.runId);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    const root = join(c.runsDir, run.displayId);
    try {
      return { files: await walk(root) };
    } catch {
      return { files: [] };
    }
  });

  app.get<{ Params: { runId: string; '*': string } }>(
    '/api/runs/:runId/artifacts/*',
    async (req, reply) => {
      if (!UUID_RE.test(req.params.runId)) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const run = c.runRepository.findByUuid(req.params.runId);
      if (!run) return reply.code(404).send({ error: 'not_found' });
      const root = join(c.runsDir, run.displayId);
      const decoded = decodeURIComponent(req.params['*']);
      const requested = normalize(decoded);
      if (requested.startsWith('..') || isAbsolute(requested)) {
        return reply.code(400).send({ error: 'invalid_path' });
      }
      const abs = join(root, requested);
      const relativePath = relative(root, abs);
      if (relativePath.startsWith('..')) {
        return reply.code(400).send({ error: 'invalid_path' });
      }
      try {
        const resolvedRoot = await realpath(root);
        const resolvedAbs = await realpath(abs);
        if (!resolvedAbs.startsWith(resolvedRoot)) {
          return reply.code(400).send({ error: 'invalid_path' });
        }
      } catch {
        return reply.code(404).send({ error: 'not_found' });
      }
      try {
        reply.header('content-type', guessType(abs));
        const stream = createReadStream(abs);
        return reply.send(stream);
      } catch {
        return reply.code(404).send({ error: 'not_found' });
      }
    },
  );
}

function guessType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.log') || lower.endsWith('.txt') || lower.endsWith('.diff'))
    return 'text/plain';
  return 'application/octet-stream';
}
