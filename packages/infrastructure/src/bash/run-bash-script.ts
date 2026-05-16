import { createWriteStream } from 'node:fs';
import { execa, type Options as ExecaOptions } from 'execa';

export interface RunBashScriptInput {
  scriptPath: string;
  args: string[];
  env: Record<string, string>;
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

  let streamError: Error | null = null;
  stdoutFile.on('error', (e: Error) => {
    streamError ??= e;
  });
  stderrFile.on('error', (e: Error) => {
    streamError ??= e;
  });
  combinedFile.on('error', (e: Error) => {
    streamError ??= e;
  });

  // Inherit parent env by default so the wrapped legacy script keeps access
  // to PATH, HOME, credentials it currently expects (GH_TOKEN, etc.). Callers
  // that need isolation should pre-filter input.env and rely on the explicit
  // overrides below; tightening to an allowlist is tracked for a later
  // milestone once we know exactly which vars the script depends on.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, input.env);

  const opts: ExecaOptions = input.cwd
    ? { env, cwd: input.cwd, reject: false, stdout: 'pipe', stderr: 'pipe' }
    : { env, reject: false, stdout: 'pipe', stderr: 'pipe' };
  const child = execa(input.scriptPath, input.args, opts);

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

  if (streamError) throw streamError;

  return {
    exitCode: result.exitCode ?? (result.signal ? 128 : 1),
    durationMs: Date.now() - startedAt,
  };
}
