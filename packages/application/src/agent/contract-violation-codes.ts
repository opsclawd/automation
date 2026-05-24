export const CONTRACT_VIOLATION_CODES = {
  PROMPT_BUDGET_EXCEEDED: 'prompt_budget_exceeded',
  MISSING_REQUIRED_ARTIFACT: 'missing_required_artifact',
  INVALID_RESULT_JSON: 'invalid_result_json',
  INVALID_RESULT_VALUE: 'invalid_result_value',
  BRANCH_CHANGED: 'branch_changed',
  MISSING_COMMIT: 'missing_commit',
  NOT_PUSHED: 'not_pushed',
  REPLIES_NOT_POSTED: 'replies_not_posted',
  CANCELLED_BY_ORCHESTRATOR: 'cancelled_by_orchestrator',
} as const;
