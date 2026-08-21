-- Setu Platform — Enforcement Layer
--
-- Everything the platform's central claim depends on lives here: the roles that
-- cannot bypass RLS, the metadata describing tenant-declared collections, and
-- the functions the generated policies and masking views call.

-- ── Runtime roles ─────────────────────────────────────────
--
-- docker-compose connects as POSTGRES_USER, which owns this database. Superusers
-- and table owners with BYPASSRLS ignore row-level security entirely, so services
-- must NOT connect as that user. These two roles exist so they can't.
--
-- setu_runtime  — the read path. Data and Gateway. Reads consent state but cannot
--                 write it, so a compromised Data service cannot grant itself
--                 consent by inserting an artifact.
-- setu_control  — the write path for consent and identity. Consent and Auth.
--
-- Neither role owns any table, so FORCE ROW LEVEL SECURITY is not needed to
-- constrain them; NOBYPASSRLS is what does the work. Collection tables still get
-- FORCE applied so the owner is constrained too.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'setu_runtime') THEN
    CREATE ROLE setu_runtime LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'setu_control') THEN
    CREATE ROLE setu_control LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Passwords are set by scripts/migrate.mjs from the environment, never stored here.

GRANT USAGE ON SCHEMA public TO setu_runtime, setu_control;

-- Read path: everything readable, nothing writable.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO setu_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO setu_runtime;

-- Control path inherits reads, and may write consent and identity state.
GRANT setu_runtime TO setu_control;

-- ── Collection metadata ───────────────────────────────────
--
-- The tenant's declared shape. The DDL generator writes these rows as the owner
-- role in the same transaction that creates the physical table, so the metadata
-- and the generated objects cannot drift apart.

CREATE TABLE IF NOT EXISTS collection_definitions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    table_name  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS field_definitions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id  UUID NOT NULL REFERENCES collection_definitions(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    pg_type        TEXT NOT NULL,
    sensitivity    TEXT NOT NULL DEFAULT 'personal'
                     CHECK (sensitivity IN ('public', 'personal', 'sensitive')),
    -- 'null' is the only strategy that is type-safe for non-text columns; the
    -- DDL generator rejects the others at declaration time on non-text fields.
    mask_strategy  TEXT NOT NULL DEFAULT 'null'
                     CHECK (mask_strategy IN ('null', 'redact', 'partial', 'hash')),
    is_nullable    BOOLEAN NOT NULL DEFAULT true,
    is_indexed     BOOLEAN NOT NULL DEFAULT false,
    is_unique      BOOLEAN NOT NULL DEFAULT false,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(collection_id, name)
);

-- The tenant's half of the two-gate field check: which purposes may read a field.
CREATE TABLE IF NOT EXISTS field_purpose_grants (
    field_id    UUID NOT NULL REFERENCES field_definitions(id) ON DELETE CASCADE,
    purpose_id  UUID NOT NULL REFERENCES purposes(id) ON DELETE CASCADE,
    PRIMARY KEY (field_id, purpose_id)
);

-- ── Identity ──────────────────────────────────────────────

-- api_keys.key_hash holds an argon2id digest, which is salted and therefore not
-- searchable. Keys are formatted setu_<prefix>_<secret>: the prefix is the lookup
-- handle, the secret is what gets verified.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_prefix TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_prefix ON api_keys(key_prefix);

CREATE TABLE IF NOT EXISTS otp_challenges (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    destination  TEXT NOT NULL,
    channel      TEXT NOT NULL CHECK (channel IN ('phone', 'email')),
    code_hash    TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    expires_at   TIMESTAMPTZ NOT NULL,
    consumed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_lookup
    ON otp_challenges(project_id, destination)
    WHERE consumed_at IS NULL;

-- Refresh tokens are 32 random bytes, so a plain sha256 is sufficient and keeps
-- them directly searchable. Argon2 is reserved for low-entropy secrets (OTP codes)
-- and for the API key secret, which is looked up by prefix rather than by digest.
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id  UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
    token_hash    TEXT NOT NULL UNIQUE,
    expires_at    TIMESTAMPTZ NOT NULL,
    revoked_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_principal
    ON refresh_tokens(principal_id)
    WHERE revoked_at IS NULL;

-- ── Audit chain ordering ──────────────────────────────────
--
-- created_at alone can tie under concurrent writes, which would make the hash
-- chain ambiguous. An identity column gives it a total order.
ALTER TABLE audit_records
    ADD COLUMN IF NOT EXISTS seq BIGINT GENERATED BY DEFAULT AS IDENTITY;

CREATE INDEX IF NOT EXISTS idx_audit_chain ON audit_records(project_id, seq DESC);

-- ── Field visibility: the two-gate check ──────────────────
--
-- A field is readable only if BOTH hold:
--   1. the tenant's policy grants this purpose access to this field, and
--   2. the principal's own consent artifact lists this field.
--
-- SECURITY DEFINER with a pinned search_path so the generated masking views keep
-- working even if the runtime role's direct SELECT on these tables is revoked later.

CREATE OR REPLACE FUNCTION public.setu_field_visible(
    p_principal_id  UUID,
    p_collection_id UUID,
    p_field         TEXT,
    p_purpose       TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM field_definitions fd
        JOIN collection_definitions cd ON cd.id = fd.collection_id
        JOIN field_purpose_grants fpg  ON fpg.field_id = fd.id          -- gate 1: tenant policy
        JOIN purposes p                ON p.id = fpg.purpose_id
        JOIN consent_artifacts ca      ON ca.purpose_id = p.id          -- gate 2: principal's consent
        WHERE fd.collection_id = p_collection_id
          AND fd.name          = p_field
          AND p.name           = p_purpose
          AND p.project_id     = cd.project_id
          AND ca.principal_id  = p_principal_id
          AND ca.status        = 'active'
          AND ca.revoked_at IS NULL
          AND (ca.expires_at IS NULL OR ca.expires_at > now())
          AND p_field = ANY(ca.fields)
    );
$$;

-- ── Hash-chained audit append ─────────────────────────────
--
-- Serialised per project by an advisory lock held to end of transaction, so two
-- concurrent writers cannot both read the same prev_hash.

CREATE OR REPLACE FUNCTION public.setu_append_audit(
    p_project_id    UUID,
    p_principal_id  UUID,
    p_purpose_id    UUID,
    p_action        TEXT,
    p_resource      TEXT,
    p_fields        TEXT[],
    p_outcome       TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_prev TEXT;
    v_hash TEXT;
    v_id   UUID;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext(p_project_id::text));

    SELECT hash INTO v_prev
      FROM audit_records
     WHERE project_id = p_project_id
     ORDER BY seq DESC
     LIMIT 1;

    v_prev := COALESCE(v_prev, '');

    v_hash := encode(digest(
        v_prev
        || p_project_id::text
        || p_principal_id::text
        || p_purpose_id::text
        || p_action
        || p_resource
        || array_to_string(p_fields, ',')
        || p_outcome, 'sha256'), 'hex');

    INSERT INTO audit_records (
        project_id, principal_id, purpose_id, action, resource, fields, outcome, prev_hash, hash
    ) VALUES (
        p_project_id, p_principal_id, p_purpose_id, p_action, p_resource, p_fields, p_outcome, v_prev, v_hash
    ) RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- ── Denial recording ──────────────────────────────────────
--
-- An RLS denial returns zero rows rather than an error, so the service cannot tell
-- "absent" from "forbidden" — and must not, since that distinction is itself a leak.
-- This function establishes the truth for the audit log only. It returns VOID
-- deliberately: the service is given nothing it could accidentally echo back.

CREATE OR REPLACE FUNCTION public.setu_audit_denial(
    p_project_id  UUID,
    p_schema      TEXT,
    p_table       TEXT,
    p_record_id   UUID,
    p_purpose_id  UUID,
    p_action      TEXT,
    p_fields      TEXT[]
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_principal UUID;
BEGIN
    -- Runs as owner, so this sees the row regardless of the caller's RLS verdict.
    EXECUTE format('SELECT principal_id FROM %I.%I WHERE id = $1', p_schema, p_table)
       INTO v_principal
      USING p_record_id;

    IF v_principal IS NULL THEN
        v_principal := NULLIF(current_setting('app.principal_id', true), '')::UUID;
    END IF;

    -- No principal to attribute the attempt to; nothing meaningful to record.
    IF v_principal IS NULL THEN
        RETURN;
    END IF;

    PERFORM public.setu_append_audit(
        p_project_id,
        v_principal,
        p_purpose_id,
        p_action,
        p_schema || '.' || p_table || '/' || p_record_id::TEXT,
        p_fields,
        'denied'
    );
END;
$$;

-- The runtime role may call these but cannot alter them.
REVOKE ALL ON FUNCTION public.setu_field_visible(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.setu_append_audit(UUID, UUID, UUID, TEXT, TEXT, TEXT[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.setu_audit_denial(UUID, TEXT, TEXT, UUID, UUID, TEXT, TEXT[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.setu_field_visible(UUID, UUID, TEXT, TEXT) TO setu_runtime, setu_control;
GRANT EXECUTE ON FUNCTION public.setu_append_audit(UUID, UUID, UUID, TEXT, TEXT, TEXT[], TEXT) TO setu_runtime, setu_control;
GRANT EXECUTE ON FUNCTION public.setu_audit_denial(UUID, TEXT, TEXT, UUID, UUID, TEXT, TEXT[]) TO setu_runtime, setu_control;

-- ── Control-path writes ───────────────────────────────────
--
-- Granted last so they apply to the tables created above as well.
GRANT INSERT, UPDATE, DELETE ON
    purposes, consent_artifacts, principals, api_keys, otp_challenges, refresh_tokens
    TO setu_control;
