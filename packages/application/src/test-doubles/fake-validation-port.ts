import type {
  ValidationPort,
  RunValidationInput,
  ValidationCommandResult,
} from '../ports/validation-port.js';
export class FakeValidationPort implements ValidationPort {
  result: ValidationCommandResult[] = [];
  lastInput?: RunValidationInput;
  async run(input: RunValidationInput): Promise<ValidationCommandResult[]> {
    this.lastInput = input;
    return this.result;
  }
}
