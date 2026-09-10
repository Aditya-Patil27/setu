-- Setu Platform — Metering
--
-- usage_records arrived in 001 with no grants, no indexes and no constraints.
-- It is operational data rather than tenant data — counts of calls and bytes,
-- never a fact about a person — which is why it carries no RLS policy and no
-- principal_id. Keeping it that way is a design rule, not an oversight: see the
-- metering service for what it refuses to accept.

-- ── Writes ────────────────────────────────────────────────
--
-- Metering joins the control path. It is granted INSERT and nothing else: a
-- usage record is an observation, and an observation that can be edited after
-- the fact is not one worth billing against.
GRANT INSERT ON usage_records TO setu_control;

-- ── Aggregation ───────────────────────────────────────────
--
-- Every read is "this project, this window", optionally narrowed to one meter.
CREATE INDEX IF NOT EXISTS idx_usage_project_time ON usage_records(project_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_project_meter ON usage_records(project_id, service, metric, recorded_at DESC);

-- ── Values that can be summed ─────────────────────────────
--
-- DOUBLE PRECISION accepts NaN and Infinity in Postgres, and a single one of
-- either silently poisons every SUM and AVG taken over the column afterwards —
-- including the ones an invoice would be built from.
--
-- The usual IEEE-754 idiom for this is `value = value`, which is false for NaN
-- in most languages. It does NOT work here: Postgres deliberately departs from
-- the standard and treats NaN as equal to itself, so that float columns can be
-- sorted and indexed at all. Comparing against the literal is what works.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usage_records_value_finite'
  ) THEN
    ALTER TABLE usage_records
      ADD CONSTRAINT usage_records_value_finite
      CHECK (value <> 'NaN'::float8
         AND value <> 'Infinity'::float8
         AND value <> '-Infinity'::float8);
  END IF;
END
$$;
