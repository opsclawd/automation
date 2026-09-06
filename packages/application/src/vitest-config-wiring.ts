/**
 * Detects a real, previously-observed incident class: an agent adds a new
 * dedicated vitest config (a real-inference/real-dependency suite, e.g.
 * `vitest.whisperx.config.ts`) plus its own `pnpm test:x` script, but never
 * wires that script into the orchestrator's own validation command list.
 * Nothing then ever runs the new suite — not CI, not the orchestrator's own
 * validation — so a broken real-dependency capability can ship with a green
 * "Validation: passed" PR. See the comfy-content-orchestrator WhisperX
 * incident (2026-09-06) for the concrete case this reproduces.
 *
 * Deliberately narrow: only flags NEWLY CREATED vitest.<name>.config.ts files
 * (via git's added-file diff, not merely present-on-disk), so a pre-existing
 * config already handled before this run started never re-triggers the check
 * on unrelated future runs.
 *
 * No config-level exclusion list: a suite that depends on real hardware or an
 * environment that isn't always present (e.g. a GPU/ComfyUI host) should
 * skip itself cleanly when its prerequisites are absent (Vitest's own
 * `it.skipIf`/`describe.skipIf`), not be excluded from validation entirely.
 * That gives strictly better coverage — it actually runs for real wherever
 * the environment permits — for no extra risk, and needs no allowlist an
 * agent could otherwise try to add itself to.
 */

const VITEST_CONFIG_PATTERN = /(?:^|\/)vitest\.[\w-]+\.config\.ts$/;

export interface UnwiredVitestConfigFinding {
  readonly file: string;
  /** The package.json script name that references this config, if one exists. */
  readonly script?: string | undefined;
}

export interface FindUnwiredVitestConfigsInput {
  /** Files added (not merely modified) since the run's start commit. */
  readonly createdFiles: readonly string[];
  /** The target repo's package.json `scripts` map. */
  readonly packageJsonScripts: Readonly<Record<string, string>>;
  /** The fully-resolved validation command list this run will actually execute. */
  readonly resolvedCommands: readonly string[];
}

function isNewSpecialVitestConfig(path: string): boolean {
  return VITEST_CONFIG_PATTERN.test(path);
}

function findReferencingScript(
  configFile: string,
  scripts: Readonly<Record<string, string>>,
): string | undefined {
  const baseName = configFile.split('/').pop() ?? configFile;
  for (const [scriptName, command] of Object.entries(scripts)) {
    if (command.includes(`--config ${baseName}`) || command.includes(`--config ./${baseName}`)) {
      return scriptName;
    }
  }
  return undefined;
}

function isCommandWired(scriptName: string, resolvedCommands: readonly string[]): boolean {
  return resolvedCommands.some((cmd) => {
    const trimmed = cmd.trim();
    return (
      trimmed === scriptName ||
      trimmed.endsWith(` ${scriptName}`) ||
      trimmed === `pnpm ${scriptName}` ||
      trimmed === `npm run ${scriptName}`
    );
  });
}

/**
 * Returns one finding per newly created special-purpose vitest config that
 * isn't wired into `resolvedCommands`. An empty array means everything new
 * is accounted for.
 */
export function findUnwiredVitestConfigs(
  input: FindUnwiredVitestConfigsInput,
): UnwiredVitestConfigFinding[] {
  const findings: UnwiredVitestConfigFinding[] = [];

  for (const path of input.createdFiles) {
    if (!isNewSpecialVitestConfig(path)) continue;

    const script = findReferencingScript(path, input.packageJsonScripts);
    if (script === undefined) {
      findings.push({ file: path });
      continue;
    }
    if (!isCommandWired(script, input.resolvedCommands)) {
      findings.push({ file: path, script });
    }
  }

  return findings;
}

export function formatUnwiredVitestConfigsMessage(
  findings: readonly UnwiredVitestConfigFinding[],
): string {
  const details = findings.map((f) =>
    f.script
      ? `${f.file} (script "${f.script}" exists in package.json but is not in validation.additionalCommands)`
      : `${f.file} (no package.json script found that runs it with --config)`,
  );
  return (
    `New vitest config file(s) introduced without a wired validation command: ${details.join('; ')}. ` +
    `Add the corresponding "pnpm test:x" command to .ai-orchestrator.json's ` +
    `validation.additionalCommands. If it depends on hardware or an environment that ` +
    `isn't always available, make the test skip itself cleanly when its prerequisites ` +
    `are absent (e.g. Vitest's it.skipIf/describe.skipIf) rather than excluding it from ` +
    `validation — it should still run for real wherever the environment permits.`
  );
}
