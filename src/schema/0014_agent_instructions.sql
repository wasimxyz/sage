-- Append-only SQLite migration. Use STRICT tables so generated types stay honest.
-- This version may never be edited after it is shipped.

-- Extra Chat instructions from Settings → Agent. The shipped prompt stays
-- in agent/agent/instructions.md. Key `user` holds appended text; an empty
-- or missing row means none. Value is encrypted when the vault is on.
CREATE TABLE agent_instruction (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
