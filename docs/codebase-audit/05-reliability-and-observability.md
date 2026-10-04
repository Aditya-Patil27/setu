# Setu Platform — Reliability, SRE & Observability Audit

## 1. Reliability & Resiliency Gaps

### 1.1 Unbounded HTTP Fetch Proxies Without Circuit Breakers or Timeouts

- **Location:** `services/gateway/src/routes/index.ts:116-126`, `services/workflow/src/invoker.ts:45-52`
- **Evidence:**
  ```ts
  const response = await fetch(upstream, {
    method: request.method,
    headers: { ... },
    body: ...
  });
  ```
- **Problem:** Native Node.js `fetch` has no default timeout. If an upstream service (e.g. Data service or Functions service) hangs or is blocked waiting for a database lock, the Gateway connection remains open indefinitely.
- **Risk:** Under upstream degradation, all available sockets and worker threads on the gateway are quickly consumed, propagating failure to every other tenant and endpoint (cascading failure).
- **Remediation:** Enforce strict per-route timeouts (`AbortSignal.timeout(ms)`), configure connection pooling for upstream HTTP agents (`undici.Agent`), and wrap upstream calls in a circuit breaker.

---

### 1.2 Lack of Health & Readiness Checks

- **Location:** `services/*/src/app.ts`
- **Evidence:**
  Every service exposes:
  ```ts
  app.get('/health', async () => ({ status: 'ok', service: '<name>' }));
  ```
- **Problem:** The `/health` endpoint is a static no-op that returns `{ status: "ok" }` regardless of whether the database connection pool is alive, saturated, or failed.
- **Risk:** Kubernetes or load balancers will continue routing traffic to pods whose database connections have crashed or timed out (liveness vs readiness conflation).
- **Remediation:** Implement separate `/healthz` (liveness: process is running) and `/readyz` (readiness: DB ping `SELECT 1` succeeds within 1s).

---

## 2. Observability Audit: "The 3 AM Question"

> **"If production breaks at 3 AM, can an engineer identify the root cause within 15 minutes?"**

### Answer: **NO.**

### Critical Observability Deficits:

1. **Zero Metrics System:** Despite claims in `README.md:98` (`Prometheus + Grafana`), there is **no metrics library, no Prometheus exporter, no `/metrics` endpoint**, and no Grafana dashboard in the repository.
2. **Missing Distributed Tracing:** There is no OpenTelemetry, Jaeger, or trace propagation. While the Gateway generates an `x-setu-request-id` header, it is not injected into a W3C `traceparent` context, and spans across Gateway -> Fastify -> Postgres are not tracked.
3. **Unstructured / Inconsistent Log Levels:** Fastify logs to stdout, but there is no standardized structured JSON log format with correlation IDs, tenant IDs, and latency metrics emitted consistently across all 9 services.
4. **Opaque Error Shielding Hiding Diagnostics:** `services/gateway/src/app.ts:80-85` intercepts all errors and maps them to a generic `{ code: 'INTERNAL_ERROR', message: 'Internal server error', requestId }`. While this protects against database connection string leakage, the actual error stack is only logged locally with `request.log.error` and cannot be queried centrally without log aggregation infrastructure.
