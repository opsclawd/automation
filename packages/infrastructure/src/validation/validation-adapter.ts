import { execa } from 'execa';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ValidationPort,
  RunValidationInput,
  ValidationCommandResult,
} from '@ai-sdlc/application/ports';

export function commandSlug(command: string): string {
  return (
    command
      .replace(/^pnpm\s+/, '')
      .replace(/^npm\s+run\s+/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'cmd'
  );
}

// pnpm subcommands that take a bare-word argument but are not package.json
// scripts (so `pnpm <word>` for these should never be treated as a missing
// script — let it run and fail/succeed on its own terms).
const PNPM_BUILTIN_SUBCOMMANDS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'update',
  'up',
  'dlx',
  'exec',
  'create',
  'init',
  'why',
  'list',
  'ls',
  'outdated',
  'link',
  'unlink',
  'rebuild',
  'prune',
  'store',
  'publish',
  'pack',
  'audit',
  'licenses',
  'patch',
  'import',
  'deploy',
  'root',
  'config',
  'env',
  'doctor',
  'self-update',
  'pkg',
  'setup',
]);

/**
 * Extracts the script name from a *bare* `pnpm <script>` / `pnpm run <script>`
 * invocation (no extra arguments, no shell chaining). Returns undefined for
 * anything else (env-var prefixes, `pnpm exec ...`, `&&` chains, etc.), which
 * intentionally leaves those commands unchecked and running as before.
 */
export function bareScriptName(command: string): string | undefined {
  const match = command.trim().match(/^pnpm\s+(?:run\s+)?([A-Za-z0-9:_-]+)$/);
  const name = match?.[1];
  if (!name || PNPM_BUILTIN_SUBCOMMANDS.has(name)) return undefined;
  return name;
}

function packageHasScript(cwd: string, script: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, unknown>;
    };
    return Boolean(pkg.scripts && Object.hasOwn(pkg.scripts, script));
  } catch {
    // Can't read/parse package.json — don't block the command on our
    // account; let it run and fail on its own terms if it's genuinely broken.
    return true;
  }
}

/**
 * `pnpm <name>` also resolves to a `node_modules/.bin/<name>` binary when
 * there's no matching package.json script (e.g. `pnpm depcruise` running the
 * dependency-cruiser CLI directly, with no "depcruise" script defined). A
 * command must fail *both* checks before we treat it as missing.
 */
function hasLocalBinary(cwd: string, name: string): boolean {
  const bin = join(cwd, 'node_modules', '.bin', name);
  return existsSync(bin) || (process.platform === 'win32' && existsSync(`${bin}.cmd`));
}

export class ProcessValidationAdapter implements ValidationPort {
  async run(input: RunValidationInput): Promise<ValidationCommandResult[]> {
    const prefix = input.logPathPrefix ?? 'validate';
    mkdirSync(input.logDir, { recursive: true });

    const results: ValidationCommandResult[] = [];
    for (let i = 0; i < input.commands.length; i++) {
      const command = input.commands[i]!;
      const slug = commandSlug(command);
      const stdoutRel = `${prefix}/${i}-${slug}.stdout.log`;
      const stderrRel = `${prefix}/${i}-${slug}.stderr.log`;
      const stdoutAbs = join(input.logDir, `${i}-${slug}.stdout.log`);
      const stderrAbs = join(input.logDir, `${i}-${slug}.stderr.log`);

      const started = Date.now();
      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      let outcome: ValidationCommandResult['outcome'] = 'passed';
      let isTimedOut = false;
      let timeoutId: NodeJS.Timeout | undefined;

      const scriptName = bareScriptName(command);
      if (
        scriptName !== undefined &&
        !packageHasScript(input.cwd, scriptName) &&
        !hasLocalBinary(input.cwd, scriptName)
      ) {
        stderr = `Skipped: no "${scriptName}" script or node_modules/.bin binary at ${input.cwd}\n`;
        outcome = 'skipped';
        const durationMs = Date.now() - started;
        writeFileSync(stdoutAbs, stdout);
        writeFileSync(stderrAbs, stderr);
        results.push({
          command,
          exitCode: 0,
          durationMs,
          stdout,
          stderr,
          stdoutPath: stdoutRel,
          stderrPath: stderrRel,
          outcome,
        });
        continue;
      }

      try {
        // POSIX-only: `detached` makes the shell a process-group leader so we
        // can kill the whole group (shell + descendants) on timeout. Without
        // this, a grandchild left running holds the stdout/stderr pipes open
        // and execa won't resolve until it exits on its own.
        const subprocess = execa(command, {
          shell: true,
          cwd: input.cwd,
          reject: false,
          all: false,
          detached: true,
          env: {
            ...process.env,
            ...(input.env ?? {}),
          },
        });

        timeoutId = setTimeout(() => {
          isTimedOut = true;
          try {
            if (subprocess.pid) {
              // Negative PID targets the whole process group.
              process.kill(-subprocess.pid, 'SIGKILL');
            }
          } catch {
            // ignore
          }
        }, input.timeoutSeconds * 1000);

        const r = await subprocess;
        if (timeoutId) clearTimeout(timeoutId);

        stdout = r.stdout ?? '';
        stderr = r.stderr ?? '';
        exitCode = r.exitCode ?? 0;

        if (isTimedOut) {
          outcome = 'timed_out';
          exitCode = r.exitCode ?? 124;
        } else if (r.failed) {
          outcome = 'failed';
          exitCode = r.exitCode ?? 1;
        }
      } catch (e) {
        if (timeoutId) clearTimeout(timeoutId);
        outcome = 'failed';
        exitCode = 1;
        stderr = String((e as Error).message);
      }
      const durationMs = Date.now() - started;

      writeFileSync(stdoutAbs, stdout);
      writeFileSync(stderrAbs, stderr);

      results.push({
        command,
        exitCode,
        durationMs,
        stdout,
        stderr,
        stdoutPath: stdoutRel,
        stderrPath: stderrRel,
        outcome,
      });
    }

    const executed = results.filter((r) => r.outcome !== 'skipped');
    const passed = executed.length > 0 && executed.every((r) => r.outcome === 'passed');
    writeFileSync(
      join(input.logDir, 'validation-result.json'),
      JSON.stringify(
        {
          passed,
          commands: results.map((r) => ({
            command: r.command,
            exitCode: r.exitCode,
            durationMs: r.durationMs,
            outcome: r.outcome,
            stdoutPath: r.stdoutPath,
            stderrPath: r.stderrPath,
          })),
        },
        null,
        2,
      ),
    );

    return results;
  }
}
