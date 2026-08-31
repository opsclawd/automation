import { describe, it, expect } from 'vitest';
import {
  buildRequirementsLedger,
  buildArchitectureRequirementsLedger,
  formatRequirementsLedgerForPrompt,
  isHardGateRequirement,
  type RequirementsLedger,
} from '../requirements-ledger.js';
import { FakeGitHubPort } from '../../test-doubles/fake-github-port.js';

describe('isHardGateRequirement', () => {
  it.each([
    ['Must ensure all stems are hashed before dispatch', true],
    ['Never dispatch without capability preflight', true],
    ['Always verify normalized output', true],
    ['Check before dispatch', true],
    ['Calculate hash of the input file', true],
    ['Prevent invalid transition', true],
    ['Preserve provenance metadata', true],
    ['Verify capability set', true],
    ['Ensure atomic commit', true],
    ['Maintain stream order', true],
    ['Handle concurrent requests safely', true],
    ['Ensure idempotent execution', true],
    ['Perform rollback on failure', true],
    ['Add optional UI styling', false],
    ['Update documentation comments', false],
    ['Rename helper function', false],
  ])('matches %s -> %s', (title, expected) => {
    expect(isHardGateRequirement(title)).toBe(expected);
  });
});

describe('buildRequirementsLedger', () => {
  it('extracts acceptance criteria from markdown checkboxes', async () => {
    const issueMd = `
# Issue Title

## Acceptance Criteria
- [ ] Strict architecture review includes representational completeness
- [x] Every ledger item must be dispositioned
* [ ] Bounded witness scenarios must be checked
`;

    const ledger = await buildRequirementsLedger({
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
    expect(acs[1]!.hardGate).toBe(true); // contains "must"
    expect(acs[2]!.id).toBe('AC-3');
    expect(acs[2]!.hardGate).toBe(true); // contains "must"
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

    const ledger = await buildRequirementsLedger({
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

  it('extracts requirements from design.md artifact when present', async () => {
    const issueMd = `
# Issue 1132
## Goal
Split post-implementation review
## Acceptance criteria
- [ ] Spec review gate
`;

    const designMd = `
# Design: Split post-implementation review

## Problem recap
Initial review is monolithic.

## Anchored Design
- Spec review evaluates full normative ledger
- Quality review covers architecture and maintainability
- Both reviews are merge-blocking gates

## Non-goals
- Do not reintroduce plan review
`;

    const ledger = await buildRequirementsLedger({
      issueNumber: 1132,
      issueMd,
      designMd,
    });

    const designItems = ledger.items.filter(
      (it) => it.source === 'design.md' && it.category === 'anchored_design',
    );
    expect(designItems.length).toBeGreaterThanOrEqual(3);
    expect(
      designItems.some((it) => it.title.includes('Spec review evaluates full normative ledger')),
    ).toBe(true);
    expect(
      designItems.some((it) =>
        it.title.includes('Quality review covers architecture and maintainability'),
      ),
    ).toBe(true);
    expect(
      designItems.some((it) => it.title.includes('Both reviews are merge-blocking gates')),
    ).toBe(true);

    const designTraps = ledger.items.filter(
      (it) => it.source === 'design.md' && it.category === 'trap_non_goal',
    );
    expect(designTraps.length).toBeGreaterThanOrEqual(1);
    expect(designTraps[0]!.title).toContain('Do not reintroduce plan review');
  });

  it('skips descriptive sections in design.md (Problem recap, Risks, Assumptions, Notes)', async () => {
    const issueMd = `# Issue 1132\n## Goal\nTest goal\n## Acceptance criteria\n- [ ] AC1`;
    const designMd = `
# Design: Some Feature

## Problem recap
The system is currently broken in state X before migration.

## Background and Context
Historical context about the legacy implementation.

## Key precedent already in the repo
Previous patterns in the repo.

## Risks / assumptions
- In-flight runs will not resume.
- Reviewer may fail closed.

## Anchored Design
- Real requirement item 1
- Real requirement item 2

## Notes and Rationale
Some notes on why this was chosen.
`;

    const ledger = await buildRequirementsLedger({
      issueNumber: 1132,
      issueMd,
      designMd,
    });

    const designItems = ledger.items.filter((it) => it.source === 'design.md');
    expect(designItems).toHaveLength(2);
    expect(designItems[0]!.title).toBe('Real requirement item 1');
    expect(designItems[1]!.title).toBe('Real requirement item 2');

    // Ensure none of the descriptive prose became ledger items
    expect(ledger.items.some((it) => it.title.includes('Problem recap'))).toBe(false);
    expect(ledger.items.some((it) => it.title.includes('currently broken'))).toBe(false);
    expect(ledger.items.some((it) => it.title.includes('Historical context'))).toBe(false);
    expect(ledger.items.some((it) => it.title.includes('In-flight runs will not resume'))).toBe(
      false,
    );
    expect(ledger.items.some((it) => it.title.includes('Some notes on why'))).toBe(false);
  });

  it('extracts requirements from issue comments when present', async () => {
    const issueMd = `# Issue 1129\n## Goal\nFix the bug`;
    const issueCommentsMd = `
## Comment by reviewer

- Must enforce conditional invariants when subtitles are present
- Must differentiate configured parameters from measured stream probe data
`;

    const ledger = await buildRequirementsLedger({
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

    const ledger = await buildRequirementsLedger({
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

  it('backward compatibility alias buildArchitectureRequirementsLedger works identically', async () => {
    const issueMd = `# Issue 1129\n## Acceptance criteria\n- [ ] AC1`;
    const ledger = await buildArchitectureRequirementsLedger({
      issueNumber: 1129,
      issueMd,
    });
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]!.id).toBe('AC-1');
  });
});

describe('formatRequirementsLedgerForPrompt', () => {
  it('formats ledger items into structured markdown for prompt inclusion including hard gate tags', () => {
    const ledger: RequirementsLedger = {
      version: 1,
      issueNumber: 1132,
      items: [
        {
          id: 'AC-1',
          category: 'acceptance_criteria',
          title: 'Must verify hash before dispatch',
          source: 'issue.md',
          hardGate: true,
        },
        {
          id: 'DESIGN-1',
          category: 'anchored_design',
          title: 'Spec review evaluates full normative ledger',
          source: 'design.md',
          hardGate: false,
        },
      ],
    };

    const text = formatRequirementsLedgerForPrompt(ledger);
    expect(text).toContain('# Requirements Ledger (Issue #1132)');
    expect(text).toContain('[AC-1] [ACCEPTANCE_CRITERIA] [HARD GATE]');
    expect(text).toContain('Must verify hash before dispatch');
    expect(text).toContain('[DESIGN-1] [ANCHORED_DESIGN]');
    expect(text).toContain('Spec review evaluates full normative ledger');
    expect(text).toContain('counterexample_considered');
  });
});
