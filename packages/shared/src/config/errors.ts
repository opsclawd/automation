export class ConfigError extends Error {
  constructor(
    message: string,
    public override cause?: unknown,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}
