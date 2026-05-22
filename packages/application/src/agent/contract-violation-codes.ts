export const CONTRACT_VIOLATION_CODES = [
  'prompt_budget_exceeded',
  'missing_required_artifact',
  'invalid_result_json',
  'invalid_result_value',
  'branch_changed',
  'missing_commit',
  'not_pushed',
  'replies_not_posted',
  'cancelled_by_orchestrator',
] as const;

export type ContractViolationCode = (typeof CONTRACT_VIOLATION_CODES)[number];
