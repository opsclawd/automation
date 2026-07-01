# Implementation Log

## Task 2: Recast the backtick title test as number-based acceptance

- Updated `packages/application/src/phases/__tests__/plan-tasks.test.ts`.
- Replaced `manifest validation: treats backtick-formatted prose heading as matching plain-text manifest title` with `manifest validation: accepts backtick-formatted headings by task number`.
- Kept the assertion focused on task-number matching while preserving the backtick-formatted heading scenario.

## Task 3: Align the implement-phase expectation with cosmetic title drift

- Updated `packages/application/src/phases/handlers/__tests__/implement.test.ts`.
- Replaced the stale failure expectation with a passing run that uses cosmetically different manifest and prose titles.
- Verified the handler still derives the task bodies by number and executes both steps.
