-- Setu Platform — Workflow
--
-- 001 kept every step's state in workflow_executions.steps, a single JSONB
-- document. That cannot be made durable: two workers advancing the same
-- execution both read the document, both modify their own copy, and the second
-- write silently erases the first. There is also nothing to stop a step running
-- twice, because "has step 3 already run" is a question about the contents of a
-- blob rather than something the database can enforce.
--
-- So steps get their own rows, and a UNIQUE (execution_id, step_index) is what
-- makes a step run at most once. The guarantee is the constraint, not careful
-- code around it.

-- ── What a workflow may run as ────────────────────────────
--
-- Same rule as functions, for the same reason. A workflow is a caller the tenant
-- wrote, and a step that could run under a purpose its function never declared
-- would make the chain a way to escalate past the function's own declaration.
-- Definition-time validation enforces that every step's function declares every
-- purpose the workflow does, so no runtime escalation is possible.
ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS purposes TEXT[] NOT NULL DEFAULT '{}';

-- ── Attributing and resuming an execution ─────────────────
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS purpose_id UUID REFERENCES purposes(id);
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS principal_id UUID REFERENCES principals(id) ON DELETE SET NULL;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS input JSONB NOT NULL DEFAULT 'null'::jsonb;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS output JSONB;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS error TEXT;

-- ── Step state, one row per step ──────────────────────────
--
-- status:
--   pending   — not yet claimed, or failed with attempts left
--   running   — claimed by a worker
--   succeeded — terminal, and never re-run
--   failed    — terminal, out of attempts
CREATE TABLE IF NOT EXISTS workflow_step_executions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    execution_id  UUID NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
    step_index    INTEGER NOT NULL,
    step_name     TEXT NOT NULL,
    function_name TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    attempts      INTEGER NOT NULL DEFAULT 0,
    output        JSONB,
    error         TEXT,
    started_at    TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The exactly-once guarantee. Two workers racing to claim the same step both
    -- attempt this pair; the database lets exactly one of them have it.
    UNIQUE (execution_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_step_execution ON workflow_step_executions(execution_id, step_index);
CREATE INDEX IF NOT EXISTS idx_workflow_exec_project ON workflow_executions(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_exec_pending ON workflow_executions(status) WHERE status IN ('pending', 'running');

-- ── Writes ────────────────────────────────────────────────
--
-- Workflow joins the control path. DELETE on step rows is withheld: a step's
-- history is the evidence that it ran at most once, and a worker that could
-- delete it could run the step again and leave no trace of having done so.
GRANT INSERT, UPDATE, DELETE ON workflow_definitions TO setu_control;
GRANT INSERT, UPDATE ON workflow_executions TO setu_control;
GRANT INSERT, UPDATE ON workflow_step_executions TO setu_control;
