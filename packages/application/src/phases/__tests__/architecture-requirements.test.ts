import { describe, it, expect } from 'vitest';
import {
  buildArchitectureRequirementsLedger,
  formatRequirementsLedgerForPrompt,
  type ArchitectureRequirementsLedger,
} from '../architecture-requirements.js';
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

  it('handles consumer issue fetch failure gracefully (fail-soft)', async () => {
    const github = new FakeGitHubPort(); // issue 999 not in map -> will throw

    const issueMd = `
# Issue 1129
Direct consumer: #999

## Acceptance criteria
- [ ] Local requirement
`;

    const ledger = await buildArchitectureRequirementsLedger({
      issueNumber: 1129,
      repoFullName: 'test-org/test-repo',
      issueMd,
      github,
    });

    // Should not throw, should contain local requirement
    expect(ledger.items.some((it) => it.title === 'Local requirement')).toBe(true);
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
    expect(text).toContain('# Architecture Requirements Ledger (Issue #1129)');
    expect(text).toContain('[AC-1] [ACCEPTANCE_CRITERIA]');
    expect(text).toContain('Representational completeness check');
    expect(text).toContain('[CONSUMER-128-AC-1] [CONSUMER_REQUIREMENT]');
    expect(text).toContain('Looping soundbed support');
    expect(text).toContain('*Context:* Timeline consumer requirement');
  });
});
