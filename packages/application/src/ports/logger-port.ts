export interface LoggerPort {
  error(message: string, ...args: unknown[]): void;
}
