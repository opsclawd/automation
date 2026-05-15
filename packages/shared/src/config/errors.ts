export class ConfigError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ConfigError';
  }
}
