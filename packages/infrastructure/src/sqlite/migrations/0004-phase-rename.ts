export const version = 4;
export const sql = /* sql */ `
-- Backfill old phase names across all persisted phase columns

-- agent_invocations
UPDATE agent_invocations SET phase_id = 'whole-pr-review' WHERE phase_id = 'review';
UPDATE agent_invocations SET phase_id = 'post-pr-review' WHERE phase_id = 'pr-review-poll';

-- events
UPDATE events SET phase = 'whole-pr-review' WHERE phase = 'review';
UPDATE events SET phase = 'post-pr-review' WHERE phase = 'pr-review-poll';

-- phases
UPDATE phases SET name = 'whole-pr-review' WHERE name = 'review';
UPDATE phases SET name = 'post-pr-review' WHERE name = 'pr-review-poll';

-- artifacts
UPDATE artifacts SET phase = 'whole-pr-review' WHERE phase = 'review';
UPDATE artifacts SET phase = 'post-pr-review' WHERE phase = 'pr-review-poll';

-- failures
UPDATE failures SET phase = 'whole-pr-review' WHERE phase = 'review';
UPDATE failures SET phase = 'post-pr-review' WHERE phase = 'pr-review-poll';

-- runs.current_phase
UPDATE runs SET current_phase = 'whole-pr-review' WHERE current_phase = 'review';
UPDATE runs SET current_phase = 'post-pr-review' WHERE current_phase = 'pr-review-poll';

-- runs.completed_phases (JSON array field)
UPDATE runs
SET completed_phases = REPLACE(
    REPLACE(completed_phases, '"review"', '"whole-pr-review"'),
    '"pr-review-poll"', '"post-pr-review"')
WHERE completed_phases LIKE '%review%';
`;
