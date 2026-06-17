export const version = 10;
export const sql = /* sql */ `
-- Backfill legacy split review-fix names into the canonical single phase name.
-- Decision #381: whole-pr-review + fix-review → review-fix (timeline collapse).
-- agent_invocations.phase_id is intentionally NOT touched — loop-internal routing
-- keys must remain unchanged per design decision 2.

-- phases
UPDATE phases SET name = 'review-fix' WHERE name IN ('whole-pr-review', 'fix-review');

-- events
UPDATE events SET phase = 'review-fix' WHERE phase IN ('whole-pr-review', 'fix-review');

-- artifacts
UPDATE artifacts SET phase = 'review-fix' WHERE phase IN ('whole-pr-review', 'fix-review');

-- failures
UPDATE failures SET phase = 'review-fix' WHERE phase IN ('whole-pr-review', 'fix-review');

-- runs.current_phase
UPDATE runs SET current_phase = 'review-fix' WHERE current_phase IN ('whole-pr-review', 'fix-review');

-- runs.completed_phases (JSON array field)
UPDATE runs
SET completed_phases = REPLACE(
    REPLACE(completed_phases, '"whole-pr-review"', '"review-fix"'),
    '"fix-review"', '"review-fix"')
WHERE completed_phases LIKE '%whole-pr-review%'
   OR completed_phases LIKE '%fix-review%';
`;
