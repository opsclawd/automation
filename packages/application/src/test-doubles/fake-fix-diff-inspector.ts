import type {
  FixDiffInspectorPort,
  FixDiffInspectorInput,
  FixDiffInspectionResult,
} from '../ports/fix-diff-inspector-port.js';

export class FakeFixDiffInspector {
  readonly calls: FixDiffInspectorInput[] = [];
  nextResult: FixDiffInspectionResult = {
    touchesPath: true,
    nearLine: true,
    reason: '',
  };
  /** When set, the next call's result is replaced by the function's return. */
  resultFn?: ((input: FixDiffInspectorInput) => FixDiffInspectionResult) | undefined;

  setNext(result: FixDiffInspectionResult): void {
    this.nextResult = result;
    this.resultFn = undefined;
  }

  setResultFn(fn: (input: FixDiffInspectorInput) => FixDiffInspectionResult): void {
    this.resultFn = fn;
  }

  async inspect(input: FixDiffInspectorInput): Promise<FixDiffInspectionResult> {
    this.calls.push(input);
    if (this.resultFn) return this.resultFn(input);
    return this.nextResult;
  }

  // Callable wrapper so the value can be passed wherever
  // FixDiffInspectorPort (a function type) is required, without losing
  // the ergonomic `.calls` / `.setNext(...)` API for tests.
  then?: never;
}

export function makeFixDiffInspector(fake: FakeFixDiffInspector): FixDiffInspectorPort {
  const fn = ((input: FixDiffInspectorInput) => fake.inspect(input)) as FixDiffInspectorPort;
  return Object.assign(fn, { calls: fake.calls, setNext: fake.setNext.bind(fake) });
}
