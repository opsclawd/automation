export class TemplateError extends Error {
  constructor(
    message: string,
    public readonly placeholder: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TemplateError';
  }
}

export class TemplateNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateNotFoundError';
  }
}
