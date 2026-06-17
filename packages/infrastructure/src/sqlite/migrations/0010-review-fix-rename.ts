export const version = 10;
export const sql = /* sql */ `
-- Backfill legacy split review-fix names into the canonical single phase name.
-- Decision #381: whole-pr-review + fix-review → review-fix (timeline collapse).
-- agent_invocations.phase_id is intentionally NOT touched — loop-internal routing
-- keys must remain unchanged per design decision 2.
--
-- ROLLBACK (if needed):
--   UPDATE phases SET name = 'whole-pr-review' WHERE name = 'review-fix';
--   UPDATE events SET phase = 'whole-pr-review' WHERE phase = 'review-fix';
--   UPDATE artifacts SET phase = 'whole-pr-review' WHERE phase = 'review-fix';
--   UPDATE failures SET phase = 'whole-pr-review' WHERE phase = 'review-fix';
--   UPDATE runs SET current_phase = 'whole-pr-review' WHERE current_phase = 'review-fix';
--   -- completed_phases rollback requires reconstructing the original array from
--   -- event data or a pre-migration backup; there is no deterministic reversal
--   -- because whole-pr-review and fix-review are collapsed into a single value.

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
-- Use json_each/json_group_array with DISTINCT to avoid duplicates
-- when both whole-pr-review and fix-review exist in the same array.
UPDATE runs
SET completed_phases = (
  SELECT json_group_array(replaced)
  FROM (
    SELECT replaced, MIN(key) AS first_seen
    FROM (
      SELECT CASE
        WHEN value = 'whole-pr-review' THEN 'review-fix'
        WHEN value = 'fix-review' THEN 'review-fix'
        ELSE value
      END AS replaced,
      key
      FROM json_each(runs.completed_phases)
    )
    GROUP BY replaced
    ORDER BY first_seen
  )
)
WHERE completed_phases LIKE '%whole-pr-review%'
   OR completed_phases LIKE '%fix-review%';
`;
