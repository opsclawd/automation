import type {
  ValidationPort,
  RunValidationInput,
  ValidationCommandResult,
} from '../ports/validation-port.js';

export class FakeValidationPort implements ValidationPort {
  result: ValidationCommandResult[] = [];

  async run(_input: RunValidationInput): Promise<ValidationCommandResult[]> {
    return this.result;
  }
}
