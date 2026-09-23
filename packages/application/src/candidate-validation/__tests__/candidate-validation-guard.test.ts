import { describe, expect, it } from 'vitest';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import { takeCandidateSnapshot, evaluateCandidateDelta } from '../candidate-validation-guard.js';

describe('takeCandidateSnapshot() and evaluateCandidateDelta()', () => {
  it('detects newly created candidate validation report with fabricated [x] GO', async () => {
    const fakeGit = new FakeGitPort();
    const cwd = '/test-repo';

    // Baseline: no candidate reports
    const baseline = await takeCandidateSnapshot(cwd, fakeGit);
    expect(baseline.size).toBe(0);

    // Agent creates a candidate validation report
    const reportPath = 'docs/phase-3-candidate-validation-report.md';
    fakeGit.worktreeFilesByCwd.set(cwd, [reportPath]);
    fakeGit.worktreeFileContents.set(`${cwd}:${reportPath}`, '# Candidate Report\n- [x] GO\n');

    const finalSnapshot = await takeCandidateSnapshot(cwd, fakeGit);
    expect(finalSnapshot.size).toBe(1);

    const delta = evaluateCandidateDelta(baseline, finalSnapshot);
    expect(delta.ok).toBe(false);
    expect(delta.findings.some((f) => f.code === 'AFFIRMATIVE_DISPOSITION')).toBe(true);
  });

  it('detects newly created recognized report that is ignored by git (Witness-2)', async () => {
    const fakeGit = new FakeGitPort();
    const cwd = '/test-repo';

    const baseline = await takeCandidateSnapshot(cwd, fakeGit);

    // Agent creates an ignored candidate report
    const ignoredReport = 'docs/phase-3-candidate-validation-report.md';
    fakeGit.worktreeIgnoredFilesByCwd.set(cwd, [ignoredReport]);
    fakeGit.worktreeFileContents.set(
      `${cwd}:${ignoredReport}`,
      '# Candidate Report\n- [x] APPROVE\n',
    );

    const finalSnapshot = await takeCandidateSnapshot(cwd, fakeGit);
    const delta = evaluateCandidateDelta(baseline, finalSnapshot);

    expect(delta.ok).toBe(false);
    expect(delta.findings.some((f) => f.code === 'AFFIRMATIVE_DISPOSITION')).toBe(true);
  });

  it('tolerates pre-existing recognized report that is unchanged', async () => {
    const fakeGit = new FakeGitPort();
    const cwd = '/test-repo';

    const existingReport = 'docs/phase-1-candidate-validation-report.md';
    const content = '# Phase 1 Report\n- [x] GO\nSigned-by: operator\n';

    fakeGit.worktreeFilesByCwd.set(cwd, [existingReport]);
    fakeGit.worktreeFileContents.set(`${cwd}:${existingReport}`, content);

    const baseline = await takeCandidateSnapshot(cwd, fakeGit);
    expect(baseline.size).toBe(1);

    // Agent invocation runs and does not modify the report
    const finalSnapshot = await takeCandidateSnapshot(cwd, fakeGit);
    const delta = evaluateCandidateDelta(baseline, finalSnapshot);

    expect(delta.ok).toBe(true);
    expect(delta.findings).toHaveLength(0);
  });

  it('detects modification of pre-existing report with fabricated sign-off', async () => {
    const fakeGit = new FakeGitPort();
    const cwd = '/test-repo';

    const reportPath = 'docs/phase-2-candidate-validation-report.md';
    fakeGit.worktreeFilesByCwd.set(cwd, [reportPath]);
    fakeGit.worktreeFileContents.set(`${cwd}:${reportPath}`, '# Phase 2 Report\n- [ ] GO\n');

    const baseline = await takeCandidateSnapshot(cwd, fakeGit);

    // Agent modifies report to add sign-off
    fakeGit.worktreeFileContents.set(
      `${cwd}:${reportPath}`,
      '# Phase 2 Report\nReviewing Authority (Sign-off): opsclawd (operator)\n',
    );

    const finalSnapshot = await takeCandidateSnapshot(cwd, fakeGit);
    const delta = evaluateCandidateDelta(baseline, finalSnapshot);

    expect(delta.ok).toBe(false);
    expect(delta.findings.some((f) => f.code === 'HUMAN_SIGN_OFF')).toBe(true);
  });

  it('halts with DELETED_RECOGNIZED_ARTIFACT when pre-existing report is deleted (Witness-3)', async () => {
    const fakeGit = new FakeGitPort();
    const cwd = '/test-repo';

    const reportPath = 'docs/phase-1-candidate-validation-report.md';
    fakeGit.worktreeFilesByCwd.set(cwd, [reportPath]);
    fakeGit.worktreeFileContents.set(
      `${cwd}:${reportPath}`,
      '# Phase 1 Report\n- [x] GO\nSigned-by: operator\n',
    );

    const baseline = await takeCandidateSnapshot(cwd, fakeGit);

    // Agent deletes the report
    fakeGit.worktreeFilesByCwd.set(cwd, []);
    fakeGit.worktreeFileContents.delete(`${cwd}:${reportPath}`);

    const finalSnapshot = await takeCandidateSnapshot(cwd, fakeGit);
    const delta = evaluateCandidateDelta(baseline, finalSnapshot);

    expect(delta.ok).toBe(false);
    expect(delta.findings).toHaveLength(1);
    expect(delta.findings[0]?.code).toBe('DELETED_RECOGNIZED_ARTIFACT');
    expect(delta.findings[0]?.path).toBe(reportPath);
  });

  it('halts with DELETED_RECOGNIZED_ARTIFACT when a report is renamed', async () => {
    const fakeGit = new FakeGitPort();
    const cwd = '/test-repo';

    const oldPath = 'docs/phase-1-candidate-validation-report.md';
    const newPath = 'docs/renamed-candidate-validation-report.md';

    fakeGit.worktreeFilesByCwd.set(cwd, [oldPath]);
    fakeGit.worktreeFileContents.set(`${cwd}:${oldPath}`, '# Phase 1\n');

    const baseline = await takeCandidateSnapshot(cwd, fakeGit);

    // Rename oldPath -> newPath
    fakeGit.worktreeFilesByCwd.set(cwd, [newPath]);
    fakeGit.worktreeFileContents.delete(`${cwd}:${oldPath}`);
    fakeGit.worktreeFileContents.set(`${cwd}:${newPath}`, '# Phase 1\n');

    const finalSnapshot = await takeCandidateSnapshot(cwd, fakeGit);
    const delta = evaluateCandidateDelta(baseline, finalSnapshot);

    expect(delta.ok).toBe(false);
    expect(delta.findings.some((f) => f.code === 'DELETED_RECOGNIZED_ARTIFACT')).toBe(true);
  });

  it('allows agent to create blank template docs/phase-3-report-template.md', async () => {
    const fakeGit = new FakeGitPort();
    const cwd = '/test-repo';

    const baseline = await takeCandidateSnapshot(cwd, fakeGit);

    // Agent creates blank template
    const templatePath = 'docs/phase-3-report-template.md';
    fakeGit.worktreeFilesByCwd.set(cwd, [templatePath]);
    fakeGit.worktreeFileContents.set(
      `${cwd}:${templatePath}`,
      '# Report Template\n- [ ] GO\n- [ ] NO-GO\nCandidate SHA: <pinned-candidate-sha>\n',
    );

    const finalSnapshot = await takeCandidateSnapshot(cwd, fakeGit);
    const delta = evaluateCandidateDelta(baseline, finalSnapshot);

    expect(delta.ok).toBe(true);
    expect(delta.findings).toHaveLength(0);
  });
});
