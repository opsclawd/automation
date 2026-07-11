import type {
  StructuredResultRepairInput,
  StructuredResultRepairPort,
  StructuredResultRepairResult,
} from '../ports/structured-result-repair-port.js';

export class FakeStructuredResultRepair implements StructuredResultRepairPort {
  readonly calls: StructuredResultRepairInput[] = [];
  response:
    | StructuredResultRepairResult
    | ((
        input: StructuredResultRepairInput,
      ) => StructuredResultRepairResult | Promise<StructuredResultRepairResult>) = {
    outcome: 'not_attempted',
  };

  async repairStructuredResult(
    input: StructuredResultRepairInput,
  ): Promise<StructuredResultRepairResult> {
    this.calls.push(input);
    if (typeof this.response === 'function') {
      return await this.response(input);
    }
    return this.response;
  }

  reset(): void {
    this.calls.length = 0;
    this.response = { outcome: 'not_attempted' };
  }
}
