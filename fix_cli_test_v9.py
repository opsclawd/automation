import re

with open('apps/api/src/__tests__/cli.test.ts', 'r') as f:
    content = f.read()

# Fix INSERT statements to include repo_id and correct counts
content = re.sub(
    r"INSERT INTO runs \(uuid, display_id, (repo_id, )?issue_number, type, status, completed_phases, started_at, pid\)\n\s+VALUES \(\?, \?, (\?, )?\?, \?, \?, \?, \?, \?\)",
    "INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at, pid)\n       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    content
)
content = re.sub(
    r"INSERT INTO runs \(uuid, display_id, (repo_id, )?issue_number, type, status, completed_phases, started_at\)\n\s+VALUES \(\?, \?, (\?, )?\?, \?, \?, \?, \?\)",
    "INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at)\n       VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    content
)

# Fix .run() calls to match 9 params (for 9 '?' in SQL)
content = re.sub(
    r"\)\.run\(\s+'cancel-uuid-test',.*?\);",
    ").run('cancel-uuid-test', 'issue-60-20260519-000000', 'owner/repo', 60, 'issue_to_pr', 'running', '[]', new Date().toISOString(), child.pid);",
    content, flags=re.DOTALL
)
content = re.sub(
    r"\)\.run\(\s+'terminal-uuid',.*?\);",
    ").run('terminal-uuid', 'issue-61-20260519-000000', 'owner/repo', 61, 'issue_to_pr', 'passed', '[]', new Date().toISOString(), null);",
    content, flags=re.DOTALL
)

# Fix .run() calls to match 8 params
def fix_8_params(m):
    uuid = m.group(1)
    issue = m.group(2)
    status = m.group(3)
    return f").run({uuid}, {issue}, 'owner/repo', {issue}, 'issue_to_pr', {status}, '[]', new Date().toISOString());"

# This is too hard with regex. I'll just do a global replace for the known patterns.

with open('apps/api/src/__tests__/cli.test.ts', 'w') as f:
    f.write(content)
