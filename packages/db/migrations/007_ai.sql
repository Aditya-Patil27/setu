-- Setu Platform — Consent-bound inference
--
-- An embedding is derived personal data, and it inherits the consent of the
-- data it was derived from. That single sentence decides everything here.
--
-- The masking view projects a row differently depending on current_setting
-- ('app.purpose'): read as support_chat it yields the patient's name, read as
-- analytics it yields '***'. So the text that gets embedded differs per purpose,
-- and a vector built from the support_chat projection encodes a name that
-- analytics was never granted. Serving one vector to both purposes would leak
-- that name — not as plaintext, but a nearest-neighbour search over it still
-- discriminates on the value.
--
-- Hence UNIQUE (record_id, purpose_id, model): a vector is scoped to the purpose
-- it was computed under, and is never reused across purposes.

-- ── Derived vectors ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS record_embeddings (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    collection_id UUID NOT NULL REFERENCES collection_definitions(id) ON DELETE CASCADE,
    record_id     UUID NOT NULL,
    -- Denormalised from the source row so the consent policy below can be
    -- evaluated without reaching into a tenant schema this migration cannot name.
    principal_id  UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
    purpose_id    UUID NOT NULL REFERENCES purposes(id) ON DELETE CASCADE,
    embedding     VECTOR(384) NOT NULL,
    -- sha256 of the masked text actually embedded. The record can change after
    -- the vector was built; comparing hashes is how a stale one is detected
    -- without re-embedding to find out.
    content_hash  TEXT NOT NULL,
    model         TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (record_id, purpose_id, model)
);

CREATE INDEX IF NOT EXISTS idx_embedding_scope
    ON record_embeddings(collection_id, purpose_id);
CREATE INDEX IF NOT EXISTS idx_embedding_principal
    ON record_embeddings(principal_id, purpose_id);

-- ── Visibility is the same mechanism as everywhere else ───
--
-- principal_id is a real column here, so the policy that governs rows governs
-- vectors verbatim. Revoking consent makes a vector invisible through row-level
-- security, with no sweep, no cache invalidation and no window during which a
-- revoked principal is still retrievable.
--
-- NULLIF(..., '') matters for the same reason it does on collection tables: an
-- unset app.project_id arrives as the empty string, and casting that to uuid
-- raises rather than returning NULL. Failing closed means no rows, not an error.
ALTER TABLE record_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_embeddings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "consent_gate" ON record_embeddings;
CREATE POLICY "consent_gate" ON record_embeddings
    FOR ALL
    USING (
      EXISTS (
        SELECT 1
          FROM public.consent_artifacts ca
          JOIN public.purposes p ON p.id = ca.purpose_id
         WHERE ca.principal_id = record_embeddings.principal_id
           -- The vector's own purpose must be the one being asked for. Without
           -- this a principal who consented to any purpose would expose every
           -- vector built about them, including ones built under a purpose this
           -- caller was never granted.
           AND p.id         = record_embeddings.purpose_id
           AND p.name       = current_setting('app.purpose', true)
           AND p.project_id = NULLIF(current_setting('app.project_id', true), '')::uuid
           AND ca.status = 'active'
           AND ca.revoked_at IS NULL
           AND (ca.expires_at IS NULL OR ca.expires_at > now())
      )
    )
    WITH CHECK (
      EXISTS (
        SELECT 1
          FROM public.consent_artifacts ca
          JOIN public.purposes p ON p.id = ca.purpose_id
         WHERE ca.principal_id = record_embeddings.principal_id
           AND p.id         = record_embeddings.purpose_id
           AND p.name       = current_setting('app.purpose', true)
           AND p.project_id = NULLIF(current_setting('app.project_id', true), '')::uuid
           AND ca.status = 'active'
           AND ca.revoked_at IS NULL
           AND (ca.expires_at IS NULL OR ca.expires_at > now())
      )
    );

-- ── Erasure is not the same obligation as visibility ──────
--
-- The policy above hides. DPDP's right to erasure requires the bytes to go, and
-- a hidden row is still a row. Conflating the two is the mistake this pair of
-- triggers exists to avoid.
--
-- Note the trigger fires on `fields` changing, not only on revocation. Narrowing
-- consent is as invalidating as withdrawing it: the masked projection changed,
-- so every vector derived from the old one describes data the principal no
-- longer permits. A stale vector is not a performance problem, it is a leak.

CREATE OR REPLACE FUNCTION public.setu_purge_embeddings_for_consent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    DELETE FROM record_embeddings
     WHERE principal_id = NEW.principal_id
       AND purpose_id   = NEW.purpose_id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_consent_purges_embeddings ON consent_artifacts;
CREATE TRIGGER trg_consent_purges_embeddings
    AFTER UPDATE ON consent_artifacts
    FOR EACH ROW
    WHEN (
      OLD.status     IS DISTINCT FROM NEW.status
      OR OLD.fields     IS DISTINCT FROM NEW.fields
      OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
      OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    )
    EXECUTE FUNCTION public.setu_purge_embeddings_for_consent();

-- The tenant half of the two-gate check invalidates just as hard. Pulling a
-- field grant changes what that purpose can see, so anything already derived
-- under it describes more than the grant now allows.
CREATE OR REPLACE FUNCTION public.setu_purge_embeddings_for_grant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_collection UUID;
BEGIN
    SELECT collection_id INTO v_collection
      FROM field_definitions
     WHERE id = OLD.field_id;

    IF v_collection IS NULL THEN
        -- The field itself was deleted; its collection cascade removes the rows.
        RETURN OLD;
    END IF;

    DELETE FROM record_embeddings
     WHERE collection_id = v_collection
       AND purpose_id    = OLD.purpose_id;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_grant_purges_embeddings ON field_purpose_grants;
CREATE TRIGGER trg_grant_purges_embeddings
    AFTER DELETE ON field_purpose_grants
    FOR EACH ROW
    EXECUTE FUNCTION public.setu_purge_embeddings_for_grant();

-- ── Grants ────────────────────────────────────────────────
--
-- The AI service reads and writes vectors on the read path, so setu_runtime
-- gets DML. RLS is what constrains it, not the grant — exactly as with
-- collection tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON record_embeddings TO setu_runtime;

REVOKE ALL ON FUNCTION public.setu_purge_embeddings_for_consent() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.setu_purge_embeddings_for_grant() FROM PUBLIC;
