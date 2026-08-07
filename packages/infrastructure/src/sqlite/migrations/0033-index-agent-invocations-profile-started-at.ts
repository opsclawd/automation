export const version = 33;

export const sql = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_agent_invocations_profile_started_id
  ON agent_invocations (profile, started_at DESC, id DESC);
`;
