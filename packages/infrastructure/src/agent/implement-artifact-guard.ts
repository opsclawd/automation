import type {
  ArtifactStore,
  GitPort,
  ImplementArtifactGuardPort,
  ImplementArtifactGuardInput,
  SynthesizedArtifact,
} from '@ai-sdlc/application/ports';
import { ArtifactNotFoundError } from '@ai-sdlc/application/ports';

const STATUS_REGEX = /^\s*(?:Status:\s*)?(DONE|DONE_WITH_CONCERNS)[.\s]*$/i;

const REQUIRED_ARTIFACT = 'implementation-log.md';

type ArtifactStoreForRun = (runId: string, cwd: string) => ArtifactStore;

export class ImplementArtifactGuard implements ImplementArtifactGuardPort {
  constructor(
    private readonly deps: {
      artifacts: ArtifactStoreForRun;
      git: GitPort;
    },
  ) {}

  async synthesizeMissingArtifactsIfDoneDeclared(
    input: ImplementArtifactGuardInput,
  ): Promise<{ synthesized: SynthesizedArtifact[] }> {
    const { git } = this.deps;
    const artifacts = this.deps.artifacts(input.runId, input.cwd);

    if (!input.expectedArtifacts.includes(REQUIRED_ARTIFACT)) {
      return { synthesized: [] };
    }

    let present = false;
    try {
      const existing = await artifacts.read(input.runId, REQUIRED_ARTIFACT);
      present = existing.trim().length > 0;
    } catch (e) {
      if (!(e instanceof ArtifactNotFoundError)) throw e;
    }
    if (present) {
      return { synthesized: [{ artifact: REQUIRED_ARTIFACT, reason: 'already_present' }] };
    }

    if (!(await this.declaredDone(input, artifacts))) {
      return { synthesized: [{ artifact: REQUIRED_ARTIFACT, reason: 'policy_not_satisfied' }] };
    }

    const endSha = input.invocationEnd.endCommitSha ?? (await git.headCommitSha(input.cwd));
    if (endSha !== input.invocationEnd.startCommitSha) {
      return { synthesized: [{ artifact: REQUIRED_ARTIFACT, reason: 'policy_not_satisfied' }] };
    }
    const porcelain = await git.status(input.cwd);
    if (porcelain.trim().length > 0) {
      return { synthesized: [{ artifact: REQUIRED_ARTIFACT, reason: 'policy_not_satisfied' }] };
    }

    const body = [
      'Status: DONE',
      `Step: implement/${input.stepIndex}`,
      `Run: ${input.runId}`,
      `Synthesized-by: orchestrator (agent omitted the mandatory write on a re-verification of work already committed at ${endSha})`,
      '',
      '# Files changed',
      'none',
      '',
      '# Commits since start',
      `none (startCommitSha == endCommitSha == ${endSha})`,
      '',
    ].join('\n');

    await artifacts.write({
      runId: input.runId,
      phaseId: input.phaseId,
      relativePath: REQUIRED_ARTIFACT,
      contents: body,
    });

    return {
      synthesized: [{ artifact: REQUIRED_ARTIFACT, reason: 'no_op_reverification_done_declared' }],
    };
  }

  private async declaredDone(
    input: ImplementArtifactGuardInput,
    artifacts: ArtifactStore,
  ): Promise<boolean> {
    if (input.invocationTranscript.resultJsonPath) {
      try {
        const content = await artifacts.read(
          input.runId,
          input.invocationTranscript.resultJsonPath,
        );
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed.result === 'string') {
          const res = parsed.result.toUpperCase();
          return res === 'DONE' || res === 'DONE_WITH_CONCERNS';
        }
      } catch {
        return false;
      }
      return false;
    }

    const tail = `${input.invocationTranscript.stdoutTail}\n${input.invocationTranscript.stderrTail}`;
    const tailLines = tail.split(/\r?\n/).slice(-40);
    return tailLines.some((line) => STATUS_REGEX.test(line));
  }
}
