import { execa } from 'execa';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ValidationPort,
  RunValidationInput,
  ValidationCommandResult,
} from '@ai-sdlc/application';

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

      try {
        const subprocess = execa(command, {
          shell: true,
          cwd: input.cwd,
          reject: false,
          all: false,
          detached: process.platform !== 'win32',
        });

        timeoutId = setTimeout(() => {
          isTimedOut = true;
          try {
            if (subprocess.pid) {
              if (process.platform === 'win32') {
                subprocess.kill('SIGKILL');
              } else {
                process.kill(-subprocess.pid, 'SIGKILL');
              }
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

    const passed = results.length > 0 && results.every((r) => r.outcome === 'passed');
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
