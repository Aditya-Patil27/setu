-- Setu Platform — Storage enforcement
--
-- storage_objects arrived in 001 as plain metadata: a bucket, a key, and a list
-- of purpose tags nothing consulted. A file about a person is personal data in
-- exactly the way a row is, so it is brought under the same rule here — the
-- database decides who may see it, and the service is not asked.

-- ── The data subject ──────────────────────────────────────
--
-- Nullable on purpose. A tenant's own asset — a logo, a template, an export
-- schema — is about nobody, and demanding a principal for it would make the
-- column a lie. Those objects are readable by any purpose; objects that name a
-- subject are not.
ALTER TABLE storage_objects ADD COLUMN IF NOT EXISTS principal_id UUID REFERENCES principals(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_storage_principal ON storage_objects(principal_id);
CREATE INDEX IF NOT EXISTS idx_storage_project_created ON storage_objects(project_id, created_at DESC);

-- The physical object behind the row. Nullable so a row can be written before
-- the bytes land, and so a failed upload leaves no half-readable object.
ALTER TABLE storage_objects ADD COLUMN IF NOT EXISTS storage_key TEXT;

-- ── Visibility ────────────────────────────────────────────
--
-- The same two gates the record path uses, in the same order:
--
--   1. the tenant's half — the object declares the purposes it may be read for,
--      in purpose_tags. An empty list means the tenant declared none, and the
--      object is readable only for objects that name no subject.
--   2. the principal's half — the data subject has an active artifact for the
--      purpose being claimed.
--
-- Both are evaluated against current_setting('app.purpose'), which withContext
-- pins to the transaction. An unset purpose matches nothing, so this fails
-- closed exactly like the generated collection policies do.
ALTER TABLE storage_objects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS storage_objects_purpose ON storage_objects;
CREATE POLICY storage_objects_purpose ON storage_objects
  USING (
    project_id = NULLIF(current_setting('app.project_id', true), '')::uuid
    AND (
      -- About nobody: no consent to evaluate, so the tenant's tags alone govern.
      principal_id IS NULL
      OR (
        current_setting('app.purpose', true) = ANY (purpose_tags)
        AND EXISTS (
          SELECT 1
            FROM consent_artifacts ca
            JOIN purposes p ON p.id = ca.purpose_id
           WHERE ca.principal_id = storage_objects.principal_id
             AND p.name       = current_setting('app.purpose', true)
             AND p.project_id = storage_objects.project_id
             AND ca.status = 'active'
             AND ca.revoked_at IS NULL
             AND (ca.expires_at IS NULL OR ca.expires_at > now())
        )
      )
    )
  )
  WITH CHECK (
    -- Writes carry the same predicate, so an object cannot be stored against a
    -- purpose its subject never agreed to.
    project_id = NULLIF(current_setting('app.project_id', true), '')::uuid
    AND (
      principal_id IS NULL
      OR (
        current_setting('app.purpose', true) = ANY (purpose_tags)
        AND EXISTS (
          SELECT 1
            FROM consent_artifacts ca
            JOIN purposes p ON p.id = ca.purpose_id
           WHERE ca.principal_id = storage_objects.principal_id
             AND p.name       = current_setting('app.purpose', true)
             AND p.project_id = storage_objects.project_id
             AND ca.status = 'active'
             AND ca.revoked_at IS NULL
             AND (ca.expires_at IS NULL OR ca.expires_at > now())
        )
      )
    )
  );

-- ── Writes ────────────────────────────────────────────────
--
-- Storage writes object metadata, so it joins the control path. It still cannot
-- write consent: that grant is not extended here, so a compromised storage
-- service cannot make an object readable by agreeing on the subject's behalf.
GRANT INSERT, UPDATE, DELETE ON storage_objects TO setu_control;
