# Onboarding a Repository

This guide covers what a **target repository** must satisfy before the orchestrator can run against it successfully. [Registering](quickstart.md#register-repositories) a checkout is quick and usually succeeds immediately; readiness is the part that takes work.

The failure mode this guide prevents is specific and expensive: a run plans correctly, implements correctly, commits, and then fails at `validate` for reasons unrelated to whether the work was right. Fix loops then burn iterations chasing tooling that was never the target repository's concern.

Work through the checklist before the first run. Everything here has caused a real failure.

## Prerequisites beyond registration

`repo register` validates the local path and GitHub identity. It does **not** check any of the following.

### 1. The working tree must be clean

An untracked file at the repository root blocks admission, including a zero-byte one left behind by a mistyped shell redirect. `git status --porcelain` must be empty before a run starts.

Confirm `.gitignore` covers the orchestrator's own scratch directories, or they will dirty the tree on every run:

```gitignore
.ai-runs/
.ai-worktrees/
.ai-tmp/
```

### 2. The lockfile must be committed and current

Before the `implement` phase, the orchestrator prepares each worktree with a fixed sequence (`apps/api/src/compose.ts`, `worktreeSetup`):

| Step                                            | Command                          | Timeout |
| ----------------------------------------------- | -------------------------------- | ------- |
| Install                                         | `pnpm install --frozen-lockfile` | 120s    |
| Build (only when the branch has no WIP commits) | `pnpm -r run --if-present build` | 180s    |

`--frozen-lockfile` fails if the lockfile disagrees with any `package.json`, so an uncommitted or stale lockfile breaks every run at setup, before an agent is invoked. The build step uses `--if-present`, so a repository with no `build` script is fine at this stage — but see the next section, because validation is stricter.

### 3. Validation commands concatenate across config layers — they do not replace

This is the trap most likely to cost a run.

Configuration is layered: automation's `.ai-orchestrator.json`, automation's `.ai-orchestrator.local.json`, then the target's committed and local files. For most keys a later layer overrides an earlier one. For `validation.commands` it does not — `packages/shared/src/config/loader.ts` concatenates:

```ts
if (Array.isArray(base) && Array.isArray(override)) {
  if (key === 'commands') {
    return [...base, ...override];
  }
```

A target repository can therefore **add** validation commands but can never **remove** an inherited one. Declaring a smaller set does not narrow anything; it appends, and any command it repeats then runs twice.

The practical consequence: **your repository must be able to satisfy every command in automation's default set**, currently

```
pnpm build   pnpm lint   pnpm typecheck   pnpm test   pnpm test:bash   pnpm boundaries
```

A missing script exits `254` (`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`), and a repository with no `package.json` at all exits `1` (`ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`). Either way `validate` fails after the implementation has already been committed.

`pnpm test:bash` is the usual casualty — it exists because this repository has a Bash suite, and a TypeScript-only target has no reason to. Until that is resolved, a target must provide the script even if it does nothing:

```json
"test:bash": "node -e \"console.log('no bash test suite in this repo; TypeScript monorepo')\""
```

That is a deliberately vacuous gate and should be treated as a temporary accommodation, not a pattern to copy elsewhere. Tracked in [#887](https://github.com/opsclawd/automation/issues/887); revisit this section when it lands.

Because the lists concatenate, a target's own config should declare **only what automation lacks**:

```json
{
  "validation": {
    "commands": ["pnpm format"],
    "timeout": 600
  }
}
```

### 4. Verify the effective command list, do not infer it

Check what will actually run:

```bash
node --input-type=module -e "
import { loadLayeredConfig } from './packages/shared/dist/index.js';
const c = loadLayeredConfig({
  automationRoot: process.cwd(),
  targetRoot: '/absolute/path/to/target',
});
console.log(JSON.stringify(c.config.validation.commands, null, 1));
console.log(JSON.stringify(c.sources, null, 1));
"
```

The parameter is `targetRoot`, not `targetRepoRoot`. Passing the wrong name is silently accepted and reports the automation-only list, which looks plausible and is wrong. Check `c.sources` and confirm the target layer shows `present: true` before trusting the output.

### 5. The `ai:*` issue labels must exist

The orchestrator sets and clears labels as a run progresses, and `create-pr`
treats a failed label update as a phase failure. On a repository that has only
GitHub's default labels, the run does all of its work, opens the PR, and then
fails:

```
failed to update issue labels: gh command failed:
gh issue edit 2 --add-label ai:pr-ready --remove-label ai:in-progress
'ai:in-progress' not found
```

Create them before the first run. Copying from a repository already onboarded
keeps names, colours, and descriptions consistent:

```bash
gh label list --repo <onboarded-repo> --json name,description,color \
  -q '.[] | select(.name|startswith("ai:")) | [.name,.description,.color] | @tsv' \
| while IFS=$'\t' read -r name desc color; do
    gh label create "$name" --repo <new-repo> --description "$desc" --color "$color"
  done
```

The current set is `ai:run-issue`, `ai:in-progress`, `ai:pr-ready`, `ai:blocked`,
`ai:failed`, and `ai:needs-human-review`.

### 6. Gates must be non-vacuous

A validation suite that passes because there is nothing to check is worse than none: it reports green and proves nothing. Before the first run, confirm each gate would actually fail on a real violation.

For an architecture boundary checker, prove it by introducing a violation and observing the rejection, then removing it:

```
error domain-only-shared: packages/domain/src/index.ts → packages/application/src/index.ts
```

For the test command, confirm it is not passing on an empty suite (`vitest run --passWithNoTests` on a repository with no tests is green and meaningless).

## Bootstrap repositories need a hand-seed

Validation is the only gate in the pipeline that is not an agent judging an agent. On a greenfield repository it cannot run, because the scripts it invokes do not exist until the first issue creates them.

Running that first issue through the orchestrator means running it with its only deterministic check absent, on the issue whose output every later issue inherits. Seed by hand instead:

- workspace definition and root scripts matching the effective validation list
- base TypeScript config
- lint, test, and formatting configuration
- the boundary checker with its rules
- CI running the same gates
- the target `.ai-orchestrator.json`
- **one real package** with a real export and a real test, so the gates are exercised rather than vacuously green, and so later packages have a worked example

Then amend the issue to state what is pre-seeded, pin the exact script names, and forbid restructuring the seeded config. Leave the remaining scope — the other packages, fixtures proving the boundaries, and documentation — to the run.

## Pre-flight

Run the real sequence in a throwaway worktree before the first issue. This is what catches a missing script while it is still cheap:

```bash
cd /path/to/target
git worktree add -q /tmp/preflight -b preflight main
cd /tmp/preflight

pnpm install --frozen-lockfile        # must finish within 120s
pnpm -r run --if-present build

# every command from the effective list, each must exit 0
for c in build lint typecheck test test:bash boundaries format; do
  pnpm "$c" >/dev/null 2>&1; echo "pnpm $c -> exit=$?"
done

cd /path/to/target
git worktree remove --force /tmp/preflight && git branch -D preflight
```

Then confirm the control-plane side:

```bash
pnpm --filter @ai-sdlc/api dev repo list | grep <name>   # enabled, healthy
git -C /path/to/target status --porcelain                # empty
```

## Checklist

- [ ] Repository cloned locally; `repo register` succeeded; `repo list` shows it enabled and healthy
- [ ] `git status --porcelain` is empty
- [ ] `.gitignore` covers `.ai-runs/`, `.ai-worktrees/`, `.ai-tmp/`
- [ ] The six `ai:*` labels exist in the GitHub repository
- [ ] Lockfile committed; `pnpm install --frozen-lockfile` succeeds in a clean worktree within 120s
- [ ] Effective validation list verified with `loadLayeredConfig` and `targetRoot`; target layer `present: true`
- [ ] Every command in the effective list exits 0 in a clean worktree
- [ ] Each gate proven to fail on a real violation, not merely to pass
- [ ] For a greenfield repository: gates seeded by hand, and the bootstrap issue amended to say so
