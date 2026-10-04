# Setu Platform — Technical Debt Register

## 1. Intentional Debt (Documented Pragmatic Tradeoffs)

### DEBT-001: Absence of Real Message Broker (In-Memory Logging Seam for Events)

- **Location:** `services/consent/src/events.ts:6-8`
- **Origin:** Documented in design spec `2026-08-21-setu-enforcement-spine-design.md:98`: _"NATS publishes go through a no-op interface for now (nats.js deliberately not a dependency yet)"_.
- **Current Cost:** Zero asynchronous event distribution; other services cannot react to consent revocations in real-time.
- **Future Cost:** High if audit or cache invalidation relies on async pub/sub.
- **Recommendation:** Implement a real NATS JetStream publisher behind `EventPublisher`.
- **Priority:** P2 | Effort: M

---

### DEBT-002: In-Process Ephemeral Rate Limiting on Single Gateway

- **Location:** `services/gateway/src/ratelimit.ts:3-8`
- **Origin:** Documented in code: _"Deliberately in-process and therefore per-instance: with N gateways a caller gets N buckets. Correct enforcement needs shared state..."_
- **Current Cost:** Rate limits do not synchronize across multiple gateway pods in Kubernetes.
- **Future Cost:** Vulnerability to distributed credential stuffing and volumetric abuse.
- **Recommendation:** Replace with a Redis sliding window rate limiter.
- **Priority:** P2 | Effort: S

---

### DEBT-003: Subprocess Functions Runtime Instead of Container Isolation

- **Location:** `services/functions/src/runtime.ts:91-98`
- **Origin:** Documented in spec: _"Multi-tenant isolation needs a container or a microVM... and this runtime is the seam that will be replaced by one, not a substitute for it."_
- **Current Cost:** Untrusted tenant code runs on host Node.js runtime.
- **Future Cost:** Severe vulnerability to container breakouts and lateral network snooping.
- **Recommendation:** Integrate gVisor (`runsc`) or WebAssembly runtime.
- **Priority:** P0 | Effort: L

---

## 2. Accidental Debt (Implementation Flaws & Structural Liabilities)

### DEBT-004: Synchronous Advisory Lock Serialization on Audit Append

- **Location:** `packages/db/migrations/002_enforcement.sql:195-201`
- **Origin:** Attempting to enforce a strictly serialized hash chain (`v_prev` -> `v_hash`) synchronously inside user transactions.
- **Current Cost:** Complete serialization of all writes and audit-bearing reads to a single thread per project.
- **Future Cost:** Hard ceiling on platform throughput.
- **Recommendation:** Move audit hash chaining to an asynchronous background worker using batched Merkle trees or batch hash chains.
- **Priority:** P1 | Effort: L

---

### DEBT-005: Broken Client SDK Diverged from Gateway Routes

- **Location:** `packages/sdk/src/client.ts:72-84`
- **Origin:** Early stub never updated when `services/data/src/routes/records.ts` and `services/gateway/src/upstreams.ts` adopted the `/v1/collections/:name/records` REST contract.
- **Current Cost:** SDK does not function at all; any client using `@setu/sdk` receives HTTP 404.
- **Future Cost:** Developer confusion and unusable client ecosystem.
- **Recommendation:** Rewrite `packages/sdk` to target real Gateway `/v1/*` routes and add comprehensive integration tests.
- **Priority:** P1 | Effort: S

---

### DEBT-006: Inconsistent Error Status in Collection Lookup

- **Location:** `services/data/src/routes/records.ts:52-57`
- **Origin:** `NotFoundCollection` extends `ValidationError` (400) instead of `NotFoundError` (404).
- **Current Cost:** Querying records for a non-existent collection returns `400 Bad Request` instead of `404 Not Found`.
- **Recommendation:** Change `NotFoundCollection` to inherit from `NotFoundError`.
- **Priority:** P3 | Effort: S
