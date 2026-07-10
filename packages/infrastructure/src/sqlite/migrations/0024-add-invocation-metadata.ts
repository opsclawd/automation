export const version = 24;

export const sql = /* sql */ `
ALTER TABLE agent_invocations ADD COLUMN prompt_hash TEXT;
ALTER TABLE agent_invocations ADD COLUMN metadata TEXT;
`;
