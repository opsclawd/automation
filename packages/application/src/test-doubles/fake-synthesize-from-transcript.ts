import type {
  SynthesizeFromTranscriptInput,
  SynthesizeFromTranscriptPort,
  SynthesizeFromTranscriptResult,
} from '../ports/synthesize-from-transcript-port.js';

export class FakeSynthesizeFromTranscript implements SynthesizeFromTranscriptPort {
  readonly calls: SynthesizeFromTranscriptInput[] = [];
  response:
    | SynthesizeFromTranscriptResult
    | ((input: SynthesizeFromTranscriptInput) => SynthesizeFromTranscriptResult) = {
    outcome: 'no_policy_match',
  };

  async synthesizeFromTranscript(
    input: SynthesizeFromTranscriptInput,
  ): Promise<SynthesizeFromTranscriptResult> {
    this.calls.push(input);
    if (typeof this.response === 'function') {
      return this.response(input);
    }
    return this.response;
  }

  reset(): void {
    this.calls.length = 0;
    this.response = { outcome: 'no_policy_match' };
  }
}
