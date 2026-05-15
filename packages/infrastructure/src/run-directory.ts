import {
  mkdirSync,
  renameSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Run } from '@ai-sdlc/domain';

export interface RunDirectoryPaths {
  runRoot: string;
  phasesDir: string;
  artifactsDir: string;
  runJsonPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  combinedLogPath: string;
  failureJsonPath: string;
  eventsJsonlPath: string;
}

export class RunDirectory {
  private constructor(public readonly paths: RunDirectoryPaths) {}

  static paths(rootDir: string, displayId: string): RunDirectoryPaths {
    const runRoot = join(rootDir, displayId);
    return {
      runRoot,
      phasesDir: join(runRoot, 'phases'),
      artifactsDir: join(runRoot, 'artifacts'),
      runJsonPath: join(runRoot, 'run.json'),
      stdoutLogPath: join(runRoot, 'stdout.log'),
      stderrLogPath: join(runRoot, 'stderr.log'),
      combinedLogPath: join(runRoot, 'combined.log'),
      failureJsonPath: join(runRoot, 'failure.json'),
      eventsJsonlPath: join(runRoot, 'events.jsonl'),
    };
  }

  static create(input: { rootDir: string; run: Run }): RunDirectory {
    const paths = RunDirectory.paths(input.rootDir, input.run.displayId);
    mkdirSync(paths.runRoot, { recursive: true });
    mkdirSync(paths.phasesDir, { recursive: true });
    mkdirSync(paths.artifactsDir, { recursive: true });
    const dir = new RunDirectory(paths);
    dir.writeRunJson(input.run);
    return dir;
  }

  get runRoot(): string {
    return this.paths.runRoot;
  }

  writeRunJson(run: Run): void {
    atomicWriteJson(this.paths.runJsonPath, run);
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}
