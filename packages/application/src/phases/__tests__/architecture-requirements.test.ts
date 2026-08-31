import { describe, it, expect } from 'vitest';
import {
  buildArchitectureRequirementsLedger,
  formatRequirementsLedgerForPrompt,
  type ArchitectureRequirementsLedger,
} from '../requirements-ledger.js';
import { FakeGitHubPort } from '../../test-doubles/fake-github-port.js';

describe('buildArchitectureRequirementsLedger', () => {
  it('extracts acceptance criteria from markdown checkboxes', async () => {
    const issueMd = `
# Issue Title

## Acceptance Criteria
- [ ] Strict architecture review includes representational completeness
- [x] Every ledger item must be dispositioned
* [ ] Bounded witness scenarios must be checked
`;

    const ledger = await buildArchitectureRequirementsLedger({
      issueNumber: 1129,
      issueMd,
    });

    expect(ledger.version).toBe(1);
    expect(ledger.issueNumber).toBe(1129);
    const acs = ledger.items.filter((it) => it.category === 'acceptance_criteria');
    expect(acs).toHaveLength(3);
    expect(acs[0]).toEqual({
      id: 'AC-1',
      category: 'acceptance_criteria',
      title: 'Strict architecture review includes representational completeness',
      source: 'issue.md',
      hardGate: false,
    });
    expect(acs[1]!.id).toBe('AC-2');
    expect(acs[2]!.id).toBe('AC-3');
  });

  it('extracts anchored sections: Goal, Anchored Design, and Non-goals', async () => {
    const issueMd = `
# Issue 1129

## Goal
Strengthen strict architecture review with representational completeness.
Ensure contracts can losslessly represent downstream behaviors.

## Required changes
### 1. Representational completeness review
### 2. Bounded witness scenarios
### 3. Provenance-layer classification

## Non-goals
- No additional architecture review phase
- No recursive issue crawling
`;

    const ledger = await buildArchitectureRequirementsLedger({
      issueNumber: 1129,
      issueMd,
    });

    const goals = ledger.items.filter((it) => it.category === 'goal');
    expect(goals.length).toBeGreaterThanOrEqual(1);
    expect(goals[0]!.id).toBe('REQ-GOAL-1');

    const designs = ledger.items.filter((it) => it.category === 'anchored_design');
    expect(designs).toHaveLength(3);
    expect(designs[0]!.id).toBe('REQ-DESIGN-1');
    expect(designs[0]!.title).toContain('Representational completeness review');
    expect(designs[1]!.id).toBe('REQ-DESIGN-2');
    expect(designs[2]!.id).toBe('REQ-DESIGN-3');

    const traps = ledger.items.filter((it) => it.category === 'trap_non_goal');
    expect(traps).toHaveLength(2);
    expect(traps[0]!.id).toBe('REQ-TRAP-1');
    expect(traps[0]!.title).toBe('No additional architecture review phase');
  });

  it('extracts requirements from issue comments when present', async () => {
    const issueMd = `# Issue 1129\n## Goal\nFix the bug`;
    const issueCommentsMd = `
## Comment by reviewer

- Must enforce conditional invariants when subtitles are present
- Must differentiate configured parameters from measured stream probe data
`;

    const ledger = await buildArchitectureRequirementsLedger({
      issueNumber: 1129,
      issueMd,
      issueCommentsMd,
    });

    const comments = ledger.items.filter((it) => it.category === 'comment');
    expect(comments).toHaveLength(2);
    expect(comments[0]!.id).toBe('COMMENT-1');
    expect(comments[0]!.title).toContain('conditional invariants');
    expect(comments[1]!.id).toBe('COMMENT-2');
    expect(comments[1]!.title).toContain('measured stream probe data');
  });

  it('discovers 1-level direct consumer issues and extracts their requirements', async () => {
    const github = new FakeGitHubPort();
    github.issues.set('test-org/test-repo/128', {
      number: 128,
      title: 'Comfy Content Orchestrator Timeline Assembly',
      body: `
# Consumer Issue 128
## Acceptance criteria
- [ ] Soundbed loop/trim to final video duration
- [ ] Measured audio stream sample rate recorded
`,
      labels: [],
    });

    const issueMd = `
# Issue 1129
Depends on #128
Direct consumer: #128

## Acceptance criteria
- [ ] Implement provider interface
`;

    const ledger = await buildArchitectureRequirementsLedger({
      issueNumber: 1129,
      repoFullName: 'test-org/test-repo',
      issueMd,
      github,
    });

    const consumerItems = ledger.items.filter((it) => it.category === 'consumer_requirement');
    expect(consumerItems).toHaveLength(2);
    expect(consumerItems[0]!.id).toBe('CONSUMER-128-AC-1');
    expect(consumerItems[0]!.title).toBe('Soundbed loop/trim to final video duration');
    expect(consumerItems[0]!.source).toBe('issue #128');
    expect(consumerItems[1]!.id).toBe('CONSUMER-128-AC-2');
  });

  it('discovers dependent consumer issues via github.searchIssues and extracts Goal and Design sections', async () => {
    const github = new FakeGitHubPort();
    github.issues.set('test-org/test-repo/130', {
      number: 130,
      title: 'Comfy Audio Quality Downstream Consumer',
      body: `
# Downstream Audio Consumer
Depends on #1129

## Goal
Require measured output audio bitrate and sample rate provenance in exported metadata.

## Required changes
- Ensure timeline exporter probes executed streams for actual bitrate.
- Persist measured stream probe outcome in job manifest.

## Acceptance criteria
- [ ] Measured audio stream sample rate recorded
`,
      labels: [],
    });

    const issueMd = `
# Issue 1129
## Goal
Support base timeline assembly
## Acceptance criteria
- [ ] Base provider interface
`;

    const ledger = await buildArchitectureRequirementsLedger({
      issueNumber: 1129,
      repoFullName: 'test-org/test-repo',
      issueMd,
      github,
    });

    const consumerItems = ledger.items.filter((it) => it.category === 'consumer_requirement');
    expect(consumerItems.length).toBeGreaterThanOrEqual(3);
    expect(consumerItems.some((it) => it.id === 'CONSUMER-130-AC-1')).toBe(true);
    expect(consumerItems.some((it) => it.id === 'CONSUMER-130-GOAL-1')).toBe(true);
    expect(consumerItems.some((it) => it.id === 'CONSUMER-130-DESIGN-1')).toBe(true);
    expect(consumerItems.find((it) => it.id === 'CONSUMER-130-GOAL-1')!.title).toContain(
      'Require measured output audio bitrate',
    );
  });

  it('distinguishes downstream consumers from upstream or historical references', async () => {
    const github = new FakeGitHubPort();
    github.issues.set('test-org/test-repo/50', {
      number: 50,
      title: 'Old historical issue',
      body: '## Acceptance criteria\n- [ ] Historical thing',
      labels: [],
    });
    github.issues.set('test-org/test-repo/51', {
      number: 51,
      title: 'Actual direct consumer',
      body: '## Acceptance criteria\n- [ ] Consumer thing',
      labels: [],
    });

    const issueMd = `
# Issue 1129
Fixes #50
Closes #50
Direct consumer: #51
## Acceptance criteria
- [ ] My AC
`;

    const ledger = await buildArchitectureRequirementsLedger({
      issueNumber: 1129,
      repoFullName: 'test-org/test-repo',
      issueMd,
      github,
    });

    // #50 should not be in ledger, #51 should be in ledger
    expect(ledger.items.some((it) => it.id.startsWith('CONSUMER-50-'))).toBe(false);
    expect(ledger.items.some((it) => it.id.startsWith('CONSUMER-51-'))).toBe(true);
  });

  it('excludes incidental issue mentions without dependency semantics', async () => {
    const github = new FakeGitHubPort();
    github.issues.set('test-org/test-repo/99', {
      number: 99,
      title: 'Unrelated issue',
      body: 'Random issue text mentioning #1129 in a footnote without dependency',
      labels: [],
    });

    const issueMd = `
# Issue 1129
See discussion in #99 for background context.
## Acceptance criteria
- [ ] My AC
`;

    const ledger = await buildArchitectureRequirementsLedger({
      issueNumber: 1129,
      repoFullName: 'test-org/test-repo',
      issueMd,
      github,
    });

    // #99 has no dependency semantics on #1129 -> excluded from direct consumers
    expect(ledger.items.some((it) => it.id.startsWith('CONSUMER-99-'))).toBe(false);
    expect(ledger.items.some((it) => it.id === 'AC-1')).toBe(true);
  });

  it('rejects reversed dependency direction in both current and candidate issues', async () => {
    const github = new FakeGitHubPort();
    github.issues.set('test-org/test-repo/100', {
      number: 100,
      title: 'Prerequisite Issue',
      body: '## Goal\nProvide underlying primitives',
      labels: [],
    });
    github.issues.set('test-org/test-repo/200', {
      number: 200,
      title: 'Precursor Issue',
      body: 'Unblocks #1129\nRequired by #1129\n## Acceptance criteria\n- [ ] Prerequisite setup',
      labels: [],
    });

    const issueMd = `
# Issue 1129
Depends on #100
Requires #100

## Acceptance criteria
- [ ] Implement feature
`;

    const ledger = await buildArchitectureRequirementsLedger({
      issueNumber: 1129,
      repoFullName: 'test-org/test-repo',
      issueMd,
      github,
    });

    // #100 (upstream of 1129) and #200 (upstream of 1129) must NOT be direct consumers
    expect(ledger.items.some((it) => it.id.startsWith('CONSUMER-100-'))).toBe(false);
    expect(ledger.items.some((it) => it.id.startsWith('CONSUMER-200-'))).toBe(false);
    expect(ledger.items.some((it) => it.id === 'AC-1')).toBe(true);
  });

  it('extracts direct consumers from comma-separated and conjunction lists', async () => {
    const github = new FakeGitHubPort();
    github.issues.set('test-org/test-repo/128', {
      number: 128,
      title: 'Soundbed Consumer',
      body: '## Acceptance criteria\n- [ ] Soundbed 12s loop',
      labels: [],
    });
    github.issues.set('test-org/test-repo/129', {
      number: 129,
      title: 'Subtitle Consumer',
      body: '## Acceptance criteria\n- [ ] Subtitle styles',
      labels: [],
    });
    github.issues.set('test-org/test-repo/130', {
      number: 130,
      title: 'Downstream Multi-Dep Consumer',
      body: 'Depends on #101, #1129, and #103\n## Acceptance criteria\n- [ ] Audio stream probe metadata',
      labels: [],
    });

    const issueMd = `
# Issue 1129
Direct consumers: #128, #129

## Acceptance criteria
- [ ] Core pipeline
`;

    const ledger = await buildArchitectureRequirementsLedger({
      issueNumber: 1129,
      repoFullName: 'test-org/test-repo',
      issueMd,
      github,
    });

    expect(ledger.items.some((it) => it.id === 'CONSUMER-128-AC-1')).toBe(true);
    expect(ledger.items.some((it) => it.id === 'CONSUMER-129-AC-1')).toBe(true);
    expect(ledger.items.some((it) => it.id === 'CONSUMER-130-AC-1')).toBe(true);
  });

  it('gracefully ignores incidental PR references (e.g. PR #126)', async () => {
    const github = new FakeGitHubPort(); // #126 is not in issues map

    const issueMd = `
# Issue 1129
See prior discussion in PR #126 and commit notes.

## Acceptance criteria
- [ ] Core pipeline
`;

    const ledger = await buildArchitectureRequirementsLedger({
      issueNumber: 1129,
      repoFullName: 'test-org/test-repo',
      issueMd,
      github,
    });

    // Incidental PR #126 reference should not throw or become a consumer requirement
    expect(ledger.items.some((it) => it.id.startsWith('CONSUMER-126-'))).toBe(false);
    expect(ledger.items.some((it) => it.id === 'AC-1')).toBe(true);
  });

  it('discovers real downstream dependent when preceded by > 10 incidental candidate references', async () => {
    const github = new FakeGitHubPort();

    // 12 incidental issues
    for (let i = 1; i <= 12; i++) {
      github.issues.set(`test-org/test-repo/${i}`, {
        number: i,
        title: `Incidental issue ${i}`,
        body: `Contextual notes without dependency`,
        labels: [],
      });
    }

    // 1 real dependent issue at #13
    github.issues.set('test-org/test-repo/13', {
      number: 13,
      title: 'Real Downstream Consumer',
      body: 'Depends on #1129\n## Acceptance criteria\n- [ ] Downstream timeline export',
      labels: [],
    });

    const issueMd = `
# Issue 1129
Incidental references: #1, #2, #3, #4, #5, #6, #7, #8, #9, #10, #11, #12.
Also note dependency in #13.

## Acceptance criteria
- [ ] Core timeline
`;

    const ledger = await buildArchitectureRequirementsLedger({
      issueNumber: 1129,
      repoFullName: 'test-org/test-repo',
      issueMd,
      github,
    });

    // Real dependent #13 must not be starved by the 12 preceding incidental candidates
    expect(ledger.items.some((it) => it.id === 'CONSUMER-13-AC-1')).toBe(true);
  });

  it('preserves search-discovered consumer directly without refetching or omission', async () => {
    const github = new FakeGitHubPort();
    // Issue #200 is in search results
    github.issues.set('test-org/test-repo/200', {
      number: 200,
      title: 'Search Discovered Consumer',
      body: 'Depends on #1129\n## Acceptance criteria\n- [ ] Search consumer AC',
      labels: [],
    });

    const issueMd = `
# Issue 1129
## Acceptance criteria
- [ ] Base feature
`;

    const ledger = await buildArchitectureRequirementsLedger({
      issueNumber: 1129,
      repoFullName: 'test-org/test-repo',
      issueMd,
      github,
    });

    expect(ledger.items.some((it) => it.id === 'CONSUMER-200-AC-1')).toBe(true);
    expect(ledger.items.find((it) => it.id === 'CONSUMER-200-AC-1')!.title).toBe(
      'Search consumer AC',
    );
  });

  it('fails closed when an unexpected network or server error occurs fetching a candidate issue', async () => {
    const github = new FakeGitHubPort();
    // Override getIssue to throw an unexpected server error
    github.getIssue = async () => {
      throw new Error('ETIMEDOUT: GitHub API network failure');
    };

    const issueMd = `
# Issue 1129
See discussion in #555.
## Acceptance criteria
- [ ] Base feature
`;

    await expect(
      buildArchitectureRequirementsLedger({
        issueNumber: 1129,
        repoFullName: 'test-org/test-repo',
        issueMd,
        github,
      }),
    ).rejects.toThrow(
      'Failed to fetch candidate issue #555: ETIMEDOUT: GitHub API network failure',
    );
  });

  it('fails closed when candidate consumer issue fetch or search fails', async () => {
    const github = new FakeGitHubPort(); // issue 999 not in map -> will throw

    const issueMd = `
# Issue 1129
Direct consumer: #999

## Acceptance criteria
- [ ] Local requirement
`;

    await expect(
      buildArchitectureRequirementsLedger({
        issueNumber: 1129,
        repoFullName: 'test-org/test-repo',
        issueMd,
        github,
      }),
    ).rejects.toThrow('Failed to fetch declared direct consumer issue #999');
  });

  it('generates fallback item when issue markdown is minimal', async () => {
    const issueMd = `Short single line issue without markdown structure`;
    const ledger = await buildArchitectureRequirementsLedger({
      issueNumber: 1129,
      issueMd,
    });

    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]!.id).toBe('REQ-1');
    expect(ledger.items[0]!.title).toContain('Short single line issue');
  });
});

describe('formatRequirementsLedgerForPrompt', () => {
  it('formats ledger items into structured markdown for prompt inclusion', () => {
    const ledger: ArchitectureRequirementsLedger = {
      version: 1,
      issueNumber: 1129,
      items: [
        {
          id: 'AC-1',
          category: 'acceptance_criteria',
          title: 'Representational completeness check',
          source: 'issue.md',
        },
        {
          id: 'CONSUMER-128-AC-1',
          category: 'consumer_requirement',
          title: 'Looping soundbed support',
          source: 'issue #128',
          description: 'Timeline consumer requirement',
        },
      ],
    };

    const text = formatRequirementsLedgerForPrompt(ledger);
    expect(text).toContain('# Requirements Ledger (Issue #1129)');
    expect(text).toContain('[AC-1] [ACCEPTANCE_CRITERIA]');
    expect(text).toContain('Representational completeness check');
    expect(text).toContain('[CONSUMER-128-AC-1] [CONSUMER_REQUIREMENT]');
    expect(text).toContain('Looping soundbed support');
    expect(text).toContain('*Context:* Timeline consumer requirement');
  });
});
