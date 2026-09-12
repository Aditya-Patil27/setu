-- Setu Platform — One person, one principal
--
-- OTP verification resolved a principal by SELECT and then INSERTed when the
-- select found nothing. Two verifications for the same phone arriving together
-- both see no row and both insert, so one person becomes two principals.
--
-- That is worse than untidy. Consent artifacts hang off principal_id, and the
-- RLS policy compares ca.principal_id against the row's owner — so a consent
-- granted as one principal is invisible to the other, and a revocation against
-- one leaves data reachable through the other. The platform's central claim is
-- that consent is enforced; a split identity silently breaks it for that person.
--
-- The fix is a constraint rather than more careful code around the check. Two
-- concurrent inserts both reach the index and the database lets exactly one win.

-- ── Partial, because both columns are nullable ────────────
--
-- A principal may be known by phone or by email, and the seed creates some with
-- neither. A plain UNIQUE (project_id, phone) would treat every NULL phone as
-- distinct — which is correct SQL and useless here, since it permits unlimited
-- rows with a NULL phone while claiming to constrain the column. The partial
-- predicate constrains only the rows where there is something to constrain.
--
-- If either statement fails, this database already holds duplicates. That is not
-- something a migration can resolve: which of two principals is the real one,
-- and what happens to the consent attributed to the other, is a decision about a
-- person's data. Reconcile them by hand, then re-run.

CREATE UNIQUE INDEX IF NOT EXISTS idx_principal_phone_unique
    ON principals(project_id, phone)
    WHERE phone IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_principal_email_unique
    ON principals(project_id, email)
    WHERE email IS NOT NULL;

-- Case matters here. 'Asha@example.com' and 'asha@example.com' are the same
-- mailbox to every mail provider but different strings to a unique index, so
-- the index above would happily admit both and the split identity returns by
-- another route. Normalising on write is the auth service's job; this comment
-- records that the index alone does not achieve it.
COMMENT ON INDEX idx_principal_email_unique IS
  'Case-sensitive. The auth service lowercases email destinations before lookup.';
