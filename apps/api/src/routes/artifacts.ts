import { readdir, stat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, normalize, relative, isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../compose.js';
import { guardRead } from './_lib.js';

interface FileEntry {
  path: string;
  size: number;
  modifiedAt: string;
}

async function walk(root: string): Promise<FileEntry[]> {
  const resolvedRoot = await realpath(root);
  const out: FileEntry[] = [];
  const visited = new Set<string>([resolvedRoot]);
  await walkInto(root, '', resolvedRoot, out, visited);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function walkInto(
  dir: string,
  prefix: string,
  resolvedRoot: string,
  out: FileEntry[],
  visited: Set<string>,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const dirent of entries) {
    const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    const abs = join(dir, dirent.name);
    // For symlinks, resolve the target and surface it as a file or recurse
    // into it as a directory — but only after confirming the realpath stays
    // inside the run root, so a symlink can't smuggle in /etc content.
    // A visited set prevents infinite recursion from symlink cycles.
    if (dirent.isSymbolicLink()) {
      const resolvedAbs = await realpath(abs).catch(() => null);
      if (!resolvedAbs) continue;
      const r = relative(resolvedRoot, resolvedAbs);
      if (r.startsWith('..') || isAbsolute(r)) continue;
      const s = await stat(resolvedAbs).catch(() => null);
      if (!s) continue;
      if (s.isDirectory()) {
        if (visited.has(resolvedAbs)) continue;
        visited.add(resolvedAbs);
        await walkInto(abs, rel, resolvedRoot, out, visited);
      } else if (s.isFile()) {
        out.push({ path: rel, size: s.size, modifiedAt: s.mtime.toISOString() });
      }
    } else if (dirent.isDirectory()) {
      const resolvedAbs = await realpath(abs).catch(() => null);
      if (resolvedAbs) {
        const r = relative(resolvedRoot, resolvedAbs);
        if (r.startsWith('..') || isAbsolute(r)) continue;
        if (visited.has(resolvedAbs)) continue;
        visited.add(resolvedAbs);
      }
      await walkInto(abs, rel, resolvedRoot, out, visited);
    } else if (dirent.isFile()) {
      const s = await stat(abs);
      out.push({ path: rel, size: s.size, modifiedAt: s.mtime.toISOString() });
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function artifactsRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/artifacts', async (req, reply) => {
    if (!UUID_RE.test(req.params.runId)) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    const result = await guardRead(req, reply, c);
    if (!result) return;
    const { run, runtime } = result;
    const root = join(runtime?.paths.runsRoot() ?? c.runsDir, run.displayId);
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
      const result = await guardRead(req, reply, c);
      if (!result) return;
      const { run, runtime } = result;
      const root = join(runtime?.paths.runsRoot() ?? c.runsDir, run.displayId);
      const requested = normalize(req.params['*']);
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
        const rel = relative(resolvedRoot, resolvedAbs);
        if (rel.startsWith('..') || isAbsolute(rel)) {
          return reply.code(400).send({ error: 'invalid_path' });
        }
      } catch {
        return reply.code(404).send({ error: 'not_found' });
      }
      const fileStat = await stat(abs).catch(() => null);
      if (!fileStat || !fileStat.isFile()) {
        return reply.code(404).send({ error: 'not_found' });
      }
      reply.header('content-type', guessType(abs));
      reply.header('content-length', String(fileStat.size));
      const stream = createReadStream(abs);
      stream.on('error', (err) => {
        req.log.error({ err }, 'artifact stream error');
        if (!reply.sent) reply.code(500).send({ error: 'read_failed' });
      });
      return reply.send(stream);
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
