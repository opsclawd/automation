# Implementation Log

## Task 2: Recast the backtick title test as number-based acceptance

- Updated `packages/application/src/phases/__tests__/plan-tasks.test.ts`.
- Replaced `manifest validation: treats backtick-formatted prose heading as matching plain-text manifest title` with `manifest validation: accepts backtick-formatted headings by task number`.
- Kept the assertion focused on task-number matching while preserving the backtick-formatted heading scenario.

## Verification

- `sed -n '550,575p' packages/application/src/phases/__tests__/plan-tasks.test.ts | rg "manifest validation: accepts backtick-formatted headings by task number"`
- `pnpm exec vitest run packages/application/src/phases/__tests__/plan-tasks.test.ts -t "manifest validation: accepts backtick-formatted headings by task number"`
- `pnpm exec eslint packages/application/src/phases/__tests__/plan-tasks.test.ts`
