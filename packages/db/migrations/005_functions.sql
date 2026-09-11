-- Setu Platform — Functions
--
-- function_definitions arrived in 001 describing how to run something — a
-- runtime, an entrypoint, a timeout — and nothing about what it is allowed to
-- see. That is the gap this migration closes.
--
-- Server-side code is the one place where "the database decides" could quietly
-- stop being true: a function is a caller the tenant wrote, and if an invocation
-- may name any purpose it likes, the function becomes a way to launder a read
-- the purpose system would otherwise refuse. So a function declares the purposes
-- it may run under, at definition time, and an invocation may only pick from
-- that list.

-- ── What a function may run as ────────────────────────────
--
-- The tenant's declaration, checked against the project's purpose registry when
-- the function is defined. An empty list is meaningful and is the default: the
-- function touches no personal data and may not be invoked with a purpose at all.
ALTER TABLE function_definitions ADD COLUMN IF NOT EXISTS purposes TEXT[] NOT NULL DEFAULT '{}';

-- The code itself. Small enough to live in the row for the runtimes that take
-- source directly; anything that needs a bundle belongs in storage_objects.
ALTER TABLE function_definitions ADD COLUMN IF NOT EXISTS source TEXT;

-- ── Attributing an execution ──────────────────────────────
--
-- An execution reachable only through its function_id cannot be scoped by
-- project without a join, and carries no record of the purpose it ran under or
-- who it ran for. All three are needed to answer "what did this function see",
-- which is the only question that matters after the fact.
ALTER TABLE function_executions ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE function_executions ADD COLUMN IF NOT EXISTS purpose_id UUID REFERENCES purposes(id);
ALTER TABLE function_executions ADD COLUMN IF NOT EXISTS principal_id UUID REFERENCES principals(id) ON DELETE SET NULL;

-- Duration is derived, but deriving it in every query invites each caller to get
-- the null handling wrong in its own way.
ALTER TABLE function_executions ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_function_project ON function_definitions(project_id, name);
CREATE INDEX IF NOT EXISTS idx_execution_function ON function_executions(function_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_project ON function_executions(project_id, created_at DESC);

-- ── A timeout that means something ────────────────────────
--
-- 001 defaulted these but never bounded them. A function declaring a timeout of
-- a day is not a function, it is a daemon, and one declaring 4 GB of memory on a
-- shared host is a denial of service against its neighbours.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'function_limits_sane') THEN
    ALTER TABLE function_definitions
      ADD CONSTRAINT function_limits_sane
      CHECK (timeout_s BETWEEN 1 AND 300 AND memory_mb BETWEEN 32 AND 1024);
  END IF;
END
$$;

-- ── Writes ────────────────────────────────────────────────
--
-- Functions joins the control path. Executions are updated as they progress from
-- pending to a terminal state, so UPDATE is granted here where metering's was
-- deliberately withheld.
GRANT INSERT, UPDATE, DELETE ON function_definitions TO setu_control;
GRANT INSERT, UPDATE ON function_executions TO setu_control;
