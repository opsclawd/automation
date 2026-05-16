import { createWriteStream } from 'node:fs';
import { execa } from 'execa';

export interface RunBashScriptInput {
  scriptPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  stdoutPath: string;
  stderrPath: string;
  combinedPath: string;
}

export interface RunBashScriptResult {
  exitCode: number;
  durationMs: number;
}

export async function runBashScript(input: RunBashScriptInput): Promise<RunBashScriptResult> {
  const startedAt = Date.now();
  const stdoutFile = createWriteStream(input.stdoutPath);
  const stderrFile = createWriteStream(input.stderrPath);
  const combinedFile = createWriteStream(input.combinedPath);

  const child = execa(input.scriptPath, input.args, {
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    reject: false,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutFile.write(chunk);
    combinedFile.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrFile.write(chunk);
    combinedFile.write(chunk);
  });

  const result = await child;

  await Promise.all([
    new Promise<void>((res) => stdoutFile.end(res)),
    new Promise<void>((res) => stderrFile.end(res)),
    new Promise<void>((res) => combinedFile.end(res)),
  ]);

  return {
    exitCode: result.exitCode ?? (result.signal ? 128 : 1),
    durationMs: Date.now() - startedAt,
  };
}
