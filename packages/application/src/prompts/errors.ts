export class TemplateError extends Error {
  constructor(
    message: string,
    public readonly placeholder: string,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

export class TemplateNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateNotFoundError';
  }
}
