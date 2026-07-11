import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach } from 'vitest';
import { openDatabase, applyMigrations } from '@ai-sdlc/infrastructure';
import { buildServer } from '../../server.js';
import { composeRoot } from '../../compose.js';
import { RepositoryId } from '@ai-sdlc/domain';

const activeServers: Awaited<ReturnType<typeof buildServer>>[] = [];

afterEach(async () => {
  for (const s of activeServers) {
    try {
      await s.close();
    } catch {}
  }
  activeServers.length = 0;
});

export async function buildTestServer() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-test-server-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);

  const scriptPath = join(dir, 'fake.sh');
  writeFileSync(scriptPath, '#!/usr/bin/env bash\necho ok\nexit 0\n');
  chmodSync(scriptPath, 0o755);

  const container = composeRoot({
    repoRoot: dir,
    scriptPath,
  });

  const app = await buildServer(container, false);
  activeServers.push(app);

  return {
    async registerRepository(fullName: string) {
      const parts = fullName.split('/');
      const owner = parts[0] || 'owner';
      const name = parts[1] || 'repo';
      const id = RepositoryId(createHash('sha256').update(fullName).digest('hex'));

      const repoPath = join(dir, id);
      const repoInput = {
        id,
        fullName,
        owner,
        name,
        localBasePath: repoPath,
        defaultBranch: 'main',
        remoteUrl: `git@github.com:${fullName}.git`,
        enabled: true,
        maxConcurrentRuns: 1,
        healthStatus: 'healthy' as const,
        healthError: null,
        lastHealthCheckAt: new Date(),
        configMetadata: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      container.repositoryRegistry.insert(repoInput);
      return { id: repoInput.id, fullName: repoInput.fullName };
    },

    async disableRepository(id: string) {
      container.repositoryRegistry.update(RepositoryId(id), { enabled: false }, new Date());
    },

    async startIssue(options: { issueNumber: number; repositoryId: string }) {
      const run = await container.startIssueRun.execute({
        issueNumber: options.issueNumber,
        repoId: RepositoryId(options.repositoryId),
      });
      return { uuid: run.uuid, repoId: run.repoId };
    },

    async get(
      url: string,
      options?: {
        query?: Record<string, string | number | boolean | undefined>;
        headers?: Record<string, string>;
      },
    ) {
      let finalUrl = url;
      if (options?.query) {
        const cleanQuery: Record<string, string> = {};
        for (const [k, v] of Object.entries(options.query)) {
          if (v !== undefined) {
            cleanQuery[k] = String(v);
          }
        }
        const q = new URLSearchParams(cleanQuery).toString();
        if (q) {
          finalUrl += `?${q}`;
        }
      }
      const res = await app.inject({
        method: 'GET',
        url: finalUrl,
        headers: options?.headers,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let json: any = {};
      try {
        json = res.json();
      } catch {}
      return {
        status: res.statusCode,
        json,
      };
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async post(url: string, body: any, options?: { headers?: Record<string, string> }) {
      const res = await app.inject({
        method: 'POST',
        url,
        payload: body,
        headers: options?.headers,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let json: any = {};
      try {
        json = res.json();
      } catch {}
      return {
        status: res.statusCode,
        json,
      };
    },

    async close() {
      await app.close();
      const idx = activeServers.indexOf(app);
      if (idx !== -1) {
        activeServers.splice(idx, 1);
      }
    },
  };
}
