# Setu Platform — Documentation Audit & Architectural Contradictions

## 1. Stale / Misleading Documentation Register

| Document                                                                 | Section / Claim                                                                                                | What the Code Actually Does                                                                             | Severity     | Recommended Action                                                                       |
| :----------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ | :----------- | :--------------------------------------------------------------------------------------- |
| `README.md:10-35`                                                        | Architecture diagram shows NATS, MinIO, Next.js Dashboard                                                      | NATS and MinIO are unintegrated; Dashboard does not exist.                                              | **HIGH**     | Update diagram to reflect actual single-database architecture and local `.storage`.      |
| `README.md:37-68`                                                        | Directory tree lists `apps/dashboard/`, `deploy/terraform/`, `docs/api/`, `docs/architecture/`, `docs/guides/` | None of these 5 directories exist in the repository.                                                    | **HIGH**     | Delete non-existent directories from tree documentation.                                 |
| `README.md:84-99`                                                        | Tech Stack table lists MinIO, NATS, Next.js, GCP Mumbai, Prometheus + Grafana                                  | None of these 5 technologies are active or configured in the code.                                      | **CRITICAL** | Correct table to list actual stack: Node.js, Fastify, PostgreSQL 16, pgvector, pgcrypto. |
| `packages/sdk/src/client.ts:13-33`                                       | SDK claims to provide a fluent client for data, auth, storage, functions                                       | Calls invalid non-existent URL `/data/:table`; has 0 implementation of auth, storage, or functions.     | **HIGH**     | Rewrite SDK to match real Gateway `/v1/*` endpoints.                                     |
| `docs/superpowers/specs/2026-08-21-setu-enforcement-spine-design.md:5-6` | States M5 Storage, M6 Functions, M7 Audit, M9 Workflow are "out of scope"                                      | These services were subsequently implemented in git commits `467e41f`, `e526074`, `418c26d`, `3f6ca0d`. | **MEDIUM**   | Mark spec as "HISTORICAL (SUPERSEDED BY IMPLEMENTATION)".                                |
| `deploy/helm/setu/values.yaml:53-56`                                     | Declares values for `dashboard` deployment on port 3100                                                        | Dashboard application code does not exist.                                                              | **MEDIUM**   | Remove dashboard section from Helm values.                                               |

---

## 2. Architectural Contradictions Summary

1. **"Privacy compliance is a property of the data plane" vs. "Unsandboxed Functions Runtime":**
   The core philosophy is that a compromised service cannot widen access because PostgreSQL enforces RLS. However, `services/functions` executes arbitrary code with host-level privileges and access to `docker.sock`, which allows complete bypass of PostgreSQL and total compromise of the database host!
2. **"Immutable Hash Chaining" vs. "Single-Threaded Advisory Lock Bottleneck":**
   The architecture attempts to guarantee audit record order via `pg_advisory_xact_lock`, which destroys the platform's multi-tenant concurrency.
3. **"Microservices Architecture" vs. "Shared Database Monolith":**
   Documentation models 9 independent microservices, but they are completely coupled by a single shared database instance, shared connection pools, and synchronous HMAC verification.
