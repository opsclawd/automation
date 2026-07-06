import re

with open('apps/api/src/__tests__/cli.test.ts', 'r') as f:
    content = f.read()

# Fix the process.exit mock to be just vi.fn() again, but we must handle the flow.
content = content.replace(
    "const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`EXIT ${code}`); }) as never);",
    "const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);"
)

# Revert the expect(...).rejects.toThrow(/EXIT/)
content = re.sub(
    r"await expect\(program\.parseAsync\(\[\n\s+'node',\n\s+'orchestrator',\n\s+'run',\n\s+'--issue',\n\s+'(\d+)',\n\s+'--executor',\n\s+'bash',\n\s+'--script',\n\s+scriptPath,\n\s+\]\)\)\.rejects\.toThrow\(/EXIT/\);",
    r"await program.parseAsync([\n      'node',\n      'orchestrator',\n      'run',\n      '--issue',\n      '\1',\n      '--executor',\n      'bash',\n      '--script',\n      scriptPath,\n    ]);",
    content
)

# In cli.ts, if enabledRepos.length === 1, it works.
# If I can ensure only 1 repo is enabled in tests, it will pass.
# Most tests use a fresh mkdtempSync root, so the DB should be empty.
# But composeRoot auto-registers a repo if resolvedRepoFullName is set.
# In tests, repoFullName is often set via composeOverrides.

# Let's fix 'CLI run command' tests to explicitly set GITHUB_REPOSITORY so auto-registration works
content = content.replace(
    "const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });",
    "const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });"
)
# Wait, it's already there.

# The error 'multiple repositories enabled' suggests that MULTIPLE repos are being registered.
# This might happen if resolvedRepoFullName changes between calls or something.
# Or if the tests are sharing a DB. But they use mkdtempSync.

# Ah! I see what happened. I added 'owner/repo' via repoFullName override,
# AND maybe something else is triggering auto-registration?
# If repoFullName override is provided, it uses it for auto-registration.
# If I call buildProgram twice in the same test, it might be an issue if they use same root.

with open('apps/api/src/__tests__/cli.test.ts', 'w') as f:
    f.write(content)
