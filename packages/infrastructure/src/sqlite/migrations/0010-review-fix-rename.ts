export const version = 10;
export const sql = /* sql */ `
-- Backfill legacy split review-fix names into the canonical single phase name.
-- Decision #381: whole-pr-review + fix-review → review-fix (timeline collapse).
-- agent_invocations.phase_id is intentionally NOT touched — loop-internal routing
-- keys must remain unchanged per design decision 2.
-- loops.phase_id is intentionally NOT touched — the review-fix route
-- (apps/api/src/routes/review-fix.ts) constructs artifact-file paths from
-- l.phaseId.  On-disk artifacts for pre-0010 loops were written under the old
-- phase-name directory (via String(ctx.phaseId) in compose.ts), so rewriting
-- loops.phase_id would cause artifact-link 404s for old runs.
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
--   -- Note: events with phase='whole-pr-review' that were excluded from rename
--   -- (terminal events on dual-phase runs) are already 'whole-pr-review' and
--   -- should not be re-updated — the rollback above must only target 'review-fix'.

-- phases
UPDATE phases SET name = 'review-fix' WHERE name IN ('whole-pr-review', 'fix-review');

-- events
-- For runs with events from both legacy phases, skip terminal events from
-- whole-pr-review to prevent the merged review-fix timeline from appearing
-- complete before fix-review events (see #381 review comment).
UPDATE events SET phase = 'review-fix'
WHERE phase IN ('whole-pr-review', 'fix-review')
  AND NOT (
    phase = 'whole-pr-review'
    AND type IN ('phase.completed', 'phase.failed', 'phase.skipped')
    AND run_uuid IN (
      SELECT DISTINCT e1.run_uuid
      FROM events e1
      INNER JOIN events e2 ON e1.run_uuid = e2.run_uuid
      WHERE e1.phase = 'whole-pr-review' AND e2.phase = 'fix-review'
    )
  );

-- artifacts
UPDATE artifacts SET phase = 'review-fix' WHERE phase IN ('whole-pr-review', 'fix-review');

-- failures
UPDATE failures SET phase = 'review-fix' WHERE phase IN ('whole-pr-review', 'fix-review');

-- loops.phase_id is intentionally NOT backfilled — the review-fix route
-- constructs artifact-file paths from l.phaseId (review-fix.ts:30-37), and
-- on-disk files for old runs live under the original phase directory names.
-- See the header comment for details.

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
