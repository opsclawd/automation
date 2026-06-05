export class GitHubFailedError extends Error {
  readonly command: string;
  readonly stderr: string;
  constructor(command: string, stderr: string) {
    super(`gh command failed: ${command}\n${stderr}`);
    this.name = 'GitHubFailedError';
    this.command = command;
    this.stderr = stderr;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}
