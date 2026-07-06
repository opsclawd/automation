import type {
  FindingEvidenceCheckInput,
  FindingEvidenceCheckResult,
  FindingEvidenceInspectorPort,
} from '../ports/finding-evidence-inspector-port.js';

export class FakeFindingEvidenceInspector {
  readonly calls: FindingEvidenceCheckInput[] = [];
  nextResult: FindingEvidenceCheckResult = {
    evidenceConfirmed: true,
    reason: 'fake: default confirmed',
  };
  /** When set, the next call's result is replaced by the function's return. */
  resultFn?: ((input: FindingEvidenceCheckInput) => FindingEvidenceCheckResult) | undefined;

  setNext(result: FindingEvidenceCheckResult): void {
    this.nextResult = result;
    this.resultFn = undefined;
  }

  setResultFn(fn: (input: FindingEvidenceCheckInput) => FindingEvidenceCheckResult): void {
    this.resultFn = fn;
  }

  async check(input: FindingEvidenceCheckInput): Promise<FindingEvidenceCheckResult> {
    this.calls.push(input);
    if (this.resultFn) return this.resultFn(input);
    return this.nextResult;
  }

  // Callable wrapper so the value can be passed wherever
  // FindingEvidenceInspectorPort (a function type) is required, without losing
  // the ergonomic `.calls` / `.setNext(...)` API for tests.
  then?: never;
}

export function makeFindingEvidenceInspector(
  fake: FakeFindingEvidenceInspector,
): FindingEvidenceInspectorPort {
  const fn = ((input: FindingEvidenceCheckInput) =>
    fake.check(input)) as FindingEvidenceInspectorPort;
  return Object.assign(fn, { calls: fake.calls, setNext: fake.setNext.bind(fake) });
}
