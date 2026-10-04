# Setu Platform — Strategic Migration Roadmap

## Phase 0 — Emergency Security & CI Stabilization (Days 1–7)

- **Task 0.1:** Delete `/var/run/docker.sock` volume mount from `docker-compose.yml:106`. Temporarily disable functions execution or enforce strict regex/AST validation on uploaded code until sandbox is deployed.
- **Task 0.2:** Fix CI pipeline:
  - Generate ESLint 9 flat configuration (`eslint.config.js`) and update script in `package.json`.
  - Run `npm run format` across the 103 failing files.
  - Remove phantom `dashboard` from `.github/workflows/ci.yml` matrix.
- **Task 0.3:** Add database migration `007_principal_constraints.sql` introducing unique partial indexes on `principals(project_id, phone)` and `principals(project_id, email)` to prevent duplicate principal race conditions.
- **Task 0.4:** Fix `packages/sdk/src/client.ts` to call `/v1/collections/:name/records` and add basic unit tests.

---

## Phase 1 — Operational Hardening & Service Consolidation (Weeks 1–4)

- **Task 1.1 (Consolidation):** Consolidate the 9 Fastify microservices into a single **Modular Monolith** application (`apps/server` or unified Fastify instance). Retain domain modules in `packages/*` and `services/*`. Eliminate internal HTTP hops, HMAC signing overhead, and 9 separate HTTP ports.
- **Task 1.2 (Auth Performance):** Replace per-request Argon2id verification with high-entropy API keys hashed via SHA-256 or introduce an in-memory LRU cache (`toad-cache` or Redis) with a 60-second TTL.
- **Task 1.3 (Connection Pooling):** Introduce PgBouncer in transaction pooling mode in front of PostgreSQL, reducing database connection count from 180+ down to 20 shared server connections.
- **Task 1.4 (Timeouts & Circuit Breakers):** Configure strict 5-second timeouts on all external network requests using `AbortSignal.timeout()`.

---

## Phase 2 — Concurrency & Sandboxing Modernization (Months 1–3)

- **Task 2.1 (Async Audit Logging):** Decouple `setu_append_audit` from the synchronous user request transaction. Publish audit records to NATS JetStream / PostgreSQL `LISTEN/NOTIFY`, and let a dedicated background worker build the hash chain in batches, eliminating `pg_advisory_xact_lock` from the read/write path.
- **Task 2.2 (Sandboxed Functions):** Replace `child_process.execFile` in `services/functions` with an isolated V8 isolate runtime (e.g. Cloudflare Workerd, `isolated-vm`, or Wasmtime) with strict memory ceilings, no host filesystem access, and no outbound socket access.
- **Task 2.3 (Storage Streaming):** Wire the Storage service to MinIO/S3 using the AWS S3 SDK. Implement multipart streaming uploads and presigned download URLs, removing Base64 string loading into Node.js heap buffers.

---

## Phase 3 — Scale & Observability (Months 3–6)

- **Task 3.1 (Full Observability):** Instrument all routes with OpenTelemetry distributed tracing and export metrics via `prom-client` to Prometheus and Grafana.
- **Task 3.2 (Field Masking Optimization):** Optimize dynamic masking views by evaluating consent matrices at connection acquisition or pre-filtering visible columns in the SQL compiler to remove row-by-row subquery joins.
- **Task 3.3 (Production Kubernetes Manifests):** Author complete Kubernetes Helm templates (Deployments, Services, ConfigMaps, Secrets, Ingress, HPA) in `deploy/helm/setu/templates`.
