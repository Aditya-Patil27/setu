# Setu Enforcement Spine — Design

**Date:** 2026-08-21
**Scope:** M1 Gateway, M2 Auth, M3 Consent, M4 Data — plus the Postgres enforcement layer they depend on.
**Out of scope:** M5 Storage, M6 Functions, M7 Audit/Metering, M9 Workflow, `packages/sdk`, `apps/dashboard`, `deploy/`.

## Thesis

Privacy compliance is a property of the data plane, not of application code. Every read carries a
declared *purpose*. Postgres — not a service — decides which rows are visible and which fields are
readable. A compromised or buggy service cannot widen access.

## 1. Enforcement layer (Postgres)

### 1.1 Runtime role

`docker-compose.yml` connects services as `POSTGRES_USER=setu`, the database owner. **Superusers bypass
RLS unconditionally; `FORCE ROW LEVEL SECURITY` does not stop them.** Migration 002 therefore creates
`setu_runtime`: `NOBYPASSRLS`, granted DML only (no DDL, no ownership). All service pools connect as
`setu_runtime`. Without this the rest of the design is decorative.

The Data service needs DDL to create tenant collections, so it holds a *second* pool as the owner role,
used exclusively by the DDL generator and never for record reads.

### 1.2 Request context as transaction-scoped GUCs

`withPurpose()` is replaced by:

```ts
withContext(pool, { projectId, purpose, principalId }, fn)
```

which issues `SET LOCAL app.project_id`, `app.purpose`, `app.principal_id`. `SET LOCAL` is
transaction-scoped and therefore safe under transaction-mode pooling; plain `SET` would leak context to
the next tenant's query on the same pooled connection.

### 1.3 Metadata tables (migration 002)

| Table | Purpose |
|---|---|
| `collection_definitions` | `(project_id, name, table_name)` — one row per declared collection |
| `field_definitions` | `(collection_id, name, pg_type, sensitivity, mask_strategy, is_nullable)` |
| `field_purpose_grants` | `(field_id, purpose_id)` — the **tenant's** policy |
| `otp_challenges` | hashed code, destination, expiry, attempt counter, consumed_at |
| `refresh_tokens` | hashed token, principal_id, expiry, revoked_at |

### 1.4 Generated objects

Declaring a collection generates three things inside `projects.schema_name`, in one transaction:

1. **Table** — `id UUID PK`, mandatory `principal_id UUID NOT NULL` (the data subject the row is
   about), declared scalar columns, `created_at`, `updated_at`. Optional tenant-declared indexes and
   unique constraints on non-sensitive columns.
2. **RLS policy** — `ENABLE` + `FORCE ROW LEVEL SECURITY`.
3. **Masking view** — `<table>_masked`, created `WITH (security_invoker = true)` so the base table's
   RLS applies as the querying role rather than the view owner.

### 1.5 Row visibility

```sql
USING (EXISTS (
  SELECT 1 FROM public.consent_artifacts ca
  JOIN public.purposes p ON p.id = ca.purpose_id
  WHERE ca.principal_id = <table>.principal_id
    AND p.name       = current_setting('app.purpose', true)
    AND p.project_id = current_setting('app.project_id', true)::uuid
    AND ca.status = 'active' AND ca.revoked_at IS NULL
    AND (ca.expires_at IS NULL OR ca.expires_at > now())))
```

Writes carry the same predicate as `WITH CHECK`, so a row cannot be written for a purpose the
principal never agreed to.

### 1.6 Field visibility — two gates

A field is readable only if **both** hold:

- the **tenant's** policy grants that purpose access to that field (`field_purpose_grants`), and
- the **principal's own** artifact lists that field (`consent_artifacts.fields`)

`setu_field_visible(principal_id, collection_id, field_name, purpose)` is `STABLE` and evaluates both.
The generated view wraps each column:

```sql
CASE WHEN public.setu_field_visible(principal_id, '<cid>', '<field>', current_setting('app.purpose', true))
     THEN col ELSE <mask> END AS col
```

**Mask strategies:** `null` (default; the only type-safe option for non-text columns), `redact` →
`'***'`, `partial` → last 4 characters, `hash` → sha256 via pgcrypto. `partial` and `hash` are
rejected at declaration time on non-text columns.

### 1.7 Audit

`setu_append_audit()` appends a hash-chained row to `audit_records` inside the caller's transaction,
taking a per-project advisory lock to serialise the chain. `setu_audit_denial()` is `SECURITY DEFINER`:
it establishes whether a row exists in order to record `outcome='denied'`, and never returns data to
the caller. NATS publishes go through a no-op interface for now (`nats.js` deliberately not a
dependency yet), so M7 can take over later without touching call sites.

## 2. Services

### 2.0 Trust model

The gateway binds purpose; the gateway is **convenience, not enforcement**. Because compose currently
publishes ports 3001–3008, anyone can call the Data service directly with a forged `x-setu-purpose`
and pick their own purpose — the DB would faithfully check consent for whatever was claimed. Two fixes:

- stop publishing internal service ports in `docker-compose.yml`
- the gateway HMAC-signs the canonical context string `tenant|project|principal|purpose|request-id`
  into `x-setu-sig`; downstream services verify before trusting any `x-setu-*` header

### 2.1 M2 Auth — `:3001`, issuance only

The gateway verifies JWTs locally with the shared secret and looks up API-key hashes itself, so Auth is
never a per-request hop.

- `POST /v1/keys`, `GET /v1/keys`, `DELETE /v1/keys/:id` — plaintext returned exactly once, argon2id hash stored
- `POST /v1/auth/otp/start` → `POST /v1/auth/otp/verify` → JWT (jose) + refresh token, bound to `principal_id`
- `POST /v1/auth/refresh` (rotating), `GET /v1/auth/me`

`OTP_PROVIDER=mock` (already in `.env.example`) logs a fixed code instead of sending.

### 2.2 M3 Consent — `:3005`, off the read path by design

- `POST/GET /v1/purposes` — the registry the RLS policy joins against
- `POST /v1/consents`, `GET /v1/consents?principal_id=`, `POST /v1/consents/:id/revoke`
- `GET /v1/consents/check` — advisory/debugging **only**, commented as such so it is never wired into a hot path
- `GET /v1/me/consents`, `POST /v1/me/consents/:id/revoke` under a principal JWT
- publishes `setu.consent.changed`

### 2.3 M4 Data — `:3002`

- `POST /v1/collections`, `GET /v1/collections`, `PATCH /v1/collections/:name` (add fields, regenerate view)
- `POST|GET|PATCH|DELETE /v1/collections/:name/records[/:id]` — reads always via `<table>_masked`

**Read API:** equality and range filters, sort on declared indexes, keyset pagination via cursor.
**Filtering or sorting on a masked column is rejected** — otherwise the filter becomes an oracle that
leaks the value the mask hides. This rejection gets its own test.

**The DDL generator is the injection surface** and gets the tightest guard: identifiers validated
against `^[a-z][a-z0-9_]{0,62}$`, reserved words rejected, rendered exclusively through `format('%I')`;
column types resolved from a fixed allowlist, never passed through from input.

### 2.4 M1 Gateway — `:3000`

Resolves credential → tenant/project/principal; requires `x-setu-purpose` on all data routes (400
without it); validates the purpose exists in that project's registry; signs the context; proxies to
3001/3002/3005. Per-key token-bucket rate limiting, deliberately thin.

## 3. Errors

`SetuError` (already in `packages/shared`) maps to `statusCode` + `toJSON()`. Everything else becomes a
500 carrying only the request id. SQL text never reaches a client. zod validates every route boundary.

**Denials are opaque to the caller and fully detailed in audit.** RLS denial returns zero rows rather
than an error, so `GET /records/:id` cannot distinguish "absent" from "forbidden" — and must not, since
that distinction is itself a leak. Both return 404; lists return `200 []`. A `WITH CHECK` violation
raises SQLSTATE `42501`, mapped to `ConsentDeniedError` (403).

**Masked fields keep their key** with a masked value, so response shape is stable across callers.

## 4. Testing

Integration tests against real Postgres — a mocked `pg` client would verify intent, not behaviour, and
behaviour is the entire claim. Three layers:

1. **SQL-level** — no HTTP. Connect as `setu_runtime`, set GUCs by hand, assert visibility and masking.
2. **Service-level** — Fastify `app.inject()`, no sockets.
3. **Cross-service** — gateway → data with a real HMAC signature.

Four negative tests are load-bearing:

- `setu_runtime` is asserted `NOBYPASSRLS` — if this regresses, every other test silently becomes meaningless
- a forged `x-setu-purpose` without a valid signature is rejected
- a DDL injection attempt through a collection name is rejected
- a filter on a masked column is rejected

Isolation: each test file provisions its own tenant + project + schema in a dedicated `setu_test`
database and drops it afterwards. The dev volume may be wiped freely (`docker compose down -v`).

## 5. Decisions taken

| Decision | Choice |
|---|---|
| Tenant data shape | Declared tables per project, real typed columns |
| Consent evaluation | Pure in-database; Consent service off the read path |
| Identities | Project API keys + principal OTP sessions |
| Collections | Flat + tenant-declared indexes and unique constraints |
| Masked field shape | Key present, masked value |
| Denials | Opaque to caller, full detail in audit |
| Toolchain | tsx for dev, tsc for build |
| Libraries | zod, jose, @node-rs/argon2. **No nats.js** — no-op publisher interface |
| Dev database | Wipe freely |
| Git | Commit per wave |

## 6. Build order

Consent precedes Data because the RLS policy references its tables. Auth and Gateway come last because
DB enforcement does not depend on either.

| Wave | Contents |
|---|---|
| 0 | Migration runner; migration 002 (runtime role, metadata tables, SQL functions); `withContext()`; test harness |
| 1 | M3 Consent |
| 2 | M4 Data |
| 3 | M2 Auth |
| 4 | M1 Gateway |
| 5 | Enforcement tests, negative tests, seed script, E2E |

## 7. Known gaps entering the build

- `package.json` references `scripts/migrate.mjs` and `scripts/seed.mjs`; neither the scripts nor the
  `scripts/` directory exist. `001_init.sql` only ever runs via `docker-entrypoint-initdb.d`, i.e. once,
  on an empty volume. A real migration runner is the first task.
- No `vitest.config.ts` exists despite `npm test` invoking vitest.
- `deploy/docker/*.Dockerfile` are unread and unverified; out of scope this pass.
