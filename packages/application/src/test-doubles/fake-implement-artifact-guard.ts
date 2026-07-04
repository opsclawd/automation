import type {
  ImplementArtifactGuardPort,
  ImplementArtifactGuardInput,
  SynthesizedArtifact,
} from '../ports/implement-artifact-guard-port.js';

export class FakeImplementArtifactGuard implements ImplementArtifactGuardPort {
  calls: ImplementArtifactGuardInput[] = [];
  nextResult: { synthesized: SynthesizedArtifact[] } = { synthesized: [] };
  throwOnCall = false;

  async synthesizeMissingArtifactsIfDoneDeclared(
    input: ImplementArtifactGuardInput,
  ): Promise<{ synthesized: SynthesizedArtifact[] }> {
    this.calls.push(input);
    if (this.throwOnCall) throw new Error('fake guard: throwOnCall');
    return this.nextResult;
  }
}
