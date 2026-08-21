-- Setu Platform — Initial Schema Bootstrap
-- This runs on first docker-compose up via the initdb mechanism.

-- Enable pgvector for embedding storage
CREATE EXTENSION IF NOT EXISTS vector;

-- Enable pgcrypto for hash functions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Platform-level tables (shared across all tenants) ─────

CREATE TABLE IF NOT EXISTS tenants (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    schema_name TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, slug)
);

-- ── Principals (data subjects) ────────────────────────────

CREATE TABLE IF NOT EXISTS principals (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    phone        TEXT,
    email        TEXT,
    display_name TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Purpose Registry ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS purposes (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    legal_basis  TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(project_id, name)
);

-- ── Consent Artifacts ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS consent_artifacts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id  UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
    purpose_id    UUID NOT NULL REFERENCES purposes(id) ON DELETE CASCADE,
    fields        TEXT[] NOT NULL DEFAULT '{}',
    granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ,
    status        TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'expired', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_consent_lookup
    ON consent_artifacts(principal_id, purpose_id)
    WHERE status = 'active';

-- ── Audit Log (append-only, hash-chained) ─────────────────

CREATE TABLE IF NOT EXISTS audit_records (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL REFERENCES projects(id),
    principal_id  UUID NOT NULL,
    purpose_id    UUID NOT NULL,
    action        TEXT NOT NULL,
    resource      TEXT NOT NULL,
    fields        TEXT[] NOT NULL DEFAULT '{}',
    outcome       TEXT NOT NULL CHECK (outcome IN ('permitted', 'denied')),
    prev_hash     TEXT NOT NULL DEFAULT '',
    hash          TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Lineage Graph (edge table) ────────────────────────────

CREATE TABLE IF NOT EXISTS audit_edges (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL REFERENCES projects(id),
    source_node   TEXT NOT NULL,
    target_node   TEXT NOT NULL,
    edge_type     TEXT NOT NULL
                    CHECK (edge_type IN ('accessed', 'derived-from', 'transmitted-to', 'delegated-to')),
    principal_id  UUID NOT NULL,
    purpose_id    UUID NOT NULL,
    fields        TEXT[] NOT NULL DEFAULT '{}',
    outcome       TEXT NOT NULL CHECK (outcome IN ('permitted', 'denied')),
    metadata      JSONB DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lineage_source ON audit_edges(source_node);
CREATE INDEX IF NOT EXISTS idx_lineage_target ON audit_edges(target_node);

-- ── API Keys ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key_hash    TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    scopes      TEXT[] NOT NULL DEFAULT '{}',
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Functions ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS function_definitions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    runtime     TEXT NOT NULL DEFAULT 'js',
    entrypoint  TEXT NOT NULL DEFAULT 'index.js',
    timeout_s   INTEGER NOT NULL DEFAULT 30,
    memory_mb   INTEGER NOT NULL DEFAULT 128,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS function_executions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    function_id   UUID NOT NULL REFERENCES function_definitions(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    stdout        TEXT,
    stderr        TEXT,
    exit_code     INTEGER,
    started_at    TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Workflows ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_definitions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    dag         JSONB NOT NULL DEFAULT '[]',
    schedule    TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS workflow_executions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id   UUID NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    steps         JSONB NOT NULL DEFAULT '{}',
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at  TIMESTAMPTZ
);

-- ── Storage Metadata ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS storage_objects (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    bucket           TEXT NOT NULL,
    key              TEXT NOT NULL,
    content_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes       BIGINT NOT NULL DEFAULT 0,
    purpose_tags     TEXT[] NOT NULL DEFAULT '{}',
    encrypted_at_rest BOOLEAN NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(project_id, bucket, key)
);

-- ── Metering ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS usage_records (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    project_id  UUID NOT NULL REFERENCES projects(id),
    service     TEXT NOT NULL,
    metric      TEXT NOT NULL,
    value       DOUBLE PRECISION NOT NULL DEFAULT 0,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_lookup ON usage_records(tenant_id, project_id, service, recorded_at);
