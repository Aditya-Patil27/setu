# Setu Platform — Performance & Scalability Audit

## 1. Hot Paths & Bottleneck Analysis

### 1.1 Concurrency Collapse via Synchronous Advisory Lock Serialization

- **Location:** `packages/db/migrations/002_enforcement.sql:195-201`
- **Evidence:**
  ```sql
  CREATE OR REPLACE FUNCTION public.setu_append_audit(...)
  ...
  BEGIN
      PERFORM pg_advisory_xact_lock(hashtext(p_project_id::text));
      SELECT hash INTO v_prev FROM audit_records WHERE project_id = p_project_id ORDER BY seq DESC LIMIT 1;
      ...
  ```
- **Code-Based Risk:** Whenever `setu_append_audit` is called (which occurs on record writes, list accesses where `principalId` is bound, and consent updates), it takes an exclusive transaction-scoped advisory lock on the project hash.
- **Impact:** Only **one** transaction per project can append to the audit log at a time. All other concurrent transactions queue up behind the advisory lock.
- **Scalability Limit:** Max throughput per tenant project is capped at `1000ms / T_write_ms` (typically ~10–30 transactions per second per project). At 10x traffic, lock timeouts occur; at 100x traffic, connection pools saturate and the database enters cascading deadlock/timeout failure.

---

### 1.2 N * M Query Multiplication in Field Masking Views

- **Location:** `services/data/src/ddl/generate.ts:158-163`, `packages/db/migrations/002_enforcement.sql:142-170`
- **Evidence:**
  ```sql
  CASE WHEN public.setu_field_visible(t."principal_id", '<collectionId>'::uuid, 'phone', current_setting('app.purpose', true))
       THEN t."phone" ELSE ... END AS "phone"
  ```
- **Code-Based Risk:** `public.setu_field_visible` runs a 5-table JOIN query (`field_definitions`, `collection_definitions`, `field_purpose_grants`, `purposes`, `consent_artifacts`).
- **Impact:** For a list query returning 1,000 records with 8 fields, PostgreSQL evaluates `setu_field_visible` 8,000 times! Because `principal_id` varies per row, PostgreSQL cannot hoist or memoize the subquery across rows.
- **Latency Risk:** Query latency scales as `O(Rows * Fields)`. A single paginated read can take hundreds of milliseconds of high-CPU query planning and execution.

---

### 1.3 Keyset Pagination & Sorting Bottlenecks

- **Location:** `services/data/src/services/records.ts:489-493`
- **Evidence:**
  ```ts
  const sql =
    `SELECT * FROM ${qualify(collection.schemaName, maskedName(collection.tableName))}` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY ${quoteIdent(query.sortColumn)} ${dir}, "id" ${dir}` +
    ` LIMIT $${params.length}`;
  ```
- **Finding:** The sorting enforcement requires sortable columns to have an index (`services/data/src/services/records.ts:205`). This is a good design for basic indexing, but composite indexes for `(sort_column, id)` are not automatically generated for tenant-declared indexes, forcing Postgres into sorting memory (`Sort Method: top-N heapsort`).

---

## 2. 10x and 100x Scalability Risk Matrix

| Component              | Current Design                                            | 10x Risk                                                 | 100x Risk                                                    | Required Architectural Change                                                         |
| :--------------------- | :-------------------------------------------------------- | :------------------------------------------------------- | :----------------------------------------------------------- | :------------------------------------------------------------------------------------ |
| **API Gateway Auth**   | Synchronous Argon2id verify per request                   | Gateway CPU pegged at 100%; event loop blocked; timeouts | Complete system outage; 504 gateway timeouts                 | High-entropy key with fast SHA-256 or in-memory LRU / Redis key cache                 |
| **Audit Chaining**     | Synchronous `pg_advisory_xact_lock` per project           | Severe lock contention; average write latency > 500ms    | Connection pool exhaustion; total write lockup               | Decouple audit log to asynchronous event queue (NATS/Kafka) with batching worker      |
| **Field Masking**      | Row-level function `setu_field_visible` per field per row | High database CPU; query latencies 100–300ms             | Database CPU exhaustion; queries exceeding statement timeout | Compile consent masks dynamically at query generation or pre-filter by consent matrix |
| **Connection Pooling** | 9 services * 20 connections = 180 connections             | Exceeds default PostgreSQL 100 `max_connections`         | Database rejects new connections (`sorry, too many clients`) | Consolidate services into Modular Monolith + place PgBouncer in transaction mode      |
| **File Storage**       | Base64 strings in JSON stored in local `.storage` disk    | Memory spikes; OOM on Node.js containers                 | Node process crashes; container restart loops                | Direct multipart streaming to MinIO / S3; eliminate Base64 encoding                   |
| **Workflow Engine**    | Polling & sequential row claims in Postgres               | Row lock contention on `workflow_step_executions`        | DB write saturation on workflow state steps                  | Dedicated message queue / Redis state machine or Temporal                             |
| **Rate Limiter**       | In-memory `TokenBuckets` on single gateway process        | Multi-replica gateways leak rate limits (N * limit)      | No cluster-wide DDoS protection                              | Redis-backed distributed sliding window rate limiter                                  |
