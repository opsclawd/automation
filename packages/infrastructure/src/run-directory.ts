import {
  createWriteStream,
  mkdirSync,
  renameSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import type { WriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Run } from '@ai-sdlc/domain';

export interface RunLogStreams {
  stdout: WriteStream;
  stderr: WriteStream;
  combined: WriteStream;
  events: WriteStream;
  closeAll(): Promise<void>;
}

export class RunDirectoryExistsError extends Error {
  constructor(
    public readonly displayId: string,
    public readonly path: string,
  ) {
    super(
      `run directory already exists for displayId '${displayId}' at ${path}. ` +
        `displayId is not unique across UTC seconds; the uuid is the primary key. ` +
        `Pass { ifExists: 'reuse' } to opt into reusing the existing directory.`,
    );
    this.name = 'RunDirectoryExistsError';
  }
}

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

  static create(input: { rootDir: string; run: Run; ifExists?: 'throw' | 'reuse' }): RunDirectory {
    const ifExists = input.ifExists ?? 'throw';
    const paths = RunDirectory.paths(input.rootDir, input.run.displayId);

    // 1. Ensure parent rootDir exists (e.g. .ai-runs/).
    // 2. Create runRoot exclusively — any concurrent creator that already
    //    won will cause EEXIST here, which we handle below.
    //    Using mkdirSync with recursive:false on an existing dir throws
    //    EEXIST on Linux (the only platform we support).
    mkdirSync(input.rootDir, { recursive: true });
    try {
      mkdirSync(paths.runRoot);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        if (ifExists === 'throw') {
          throw new RunDirectoryExistsError(input.run.displayId, paths.runRoot);
        }
      } else {
        throw e;
      }
    }
    const rootDirParent = dirname(input.rootDir);
    const rootDirParentFd = openSync(rootDirParent, 'r');
    try {
      fsyncSync(rootDirParentFd);
    } finally {
      closeSync(rootDirParentFd);
    }
    const rootDirFd = openSync(input.rootDir, 'r');
    try {
      fsyncSync(rootDirFd);
    } finally {
      closeSync(rootDirFd);
    }

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

  // Open append-mode write streams for the run's log files. Caller owns
  // lifecycle and must invoke closeAll() before the run terminates.
  // Append (not truncate) so resumed runs preserve prior output.
  openLogStreams(): RunLogStreams {
    const stdout = createWriteStream(this.paths.stdoutLogPath, { flags: 'a' });
    const stderr = createWriteStream(this.paths.stderrLogPath, { flags: 'a' });
    const combined = createWriteStream(this.paths.combinedLogPath, { flags: 'a' });
    const events = createWriteStream(this.paths.eventsJsonlPath, { flags: 'a' });
    return {
      stdout,
      stderr,
      combined,
      events,
      closeAll(): Promise<void> {
        return Promise.all(
          [stdout, stderr, combined, events].map(
            (s) => new Promise<void>((resolve) => s.end(resolve)),
          ),
        ).then(() => undefined);
      },
    };
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  const dir = dirname(path);
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}
