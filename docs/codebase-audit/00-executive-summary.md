# Setu Platform — FAANG-Level CTO Codebase Audit: Executive Summary

## 1. Overall Rating & Assessment

**Overall Score:** **5.4 / 10**

**Engineering Maturity:** **Early Prototype / Academic Proof-of-Concept** (Self-identified in `README.md:116` as a course project for MM0301A Cloud Computing, VIT Pune).

**CTO Strategic Recommendation:** **Major Refactoring & Consolidation Required (Consolidate into a Modular Monolith with Production Hardening)**

---

## 2. Executive Thesis

If appointed CTO of Setu tomorrow, **I would NOT trust this codebase in its current form to build the next 3–5 years of the company on top of it without immediate architectural and operational intervention.**

The repository contains an intellectually elegant, sophisticated core concept: **pushing privacy compliance (DPDP Act) into the PostgreSQL data plane using transaction-scoped GUCs (`set_config(..., is_local => true)`), Row-Level Security (`FORCE ROW LEVEL SECURITY`), and dynamic masking views (`security_invoker = true`) with cryptographic audit chaining.** When evaluated purely as a proof-of-concept for in-database consent enforcement, it is exceptionally clever and well-reasoned.

However, as a production system intended to support millions of users, multi-tenant cloud workloads, and multi-team scale, it suffers from **severe structural, operational, and architectural liabilities**:

1. **Catastrophic Host-Takeover / Container Breakout Vulnerability (P0):** `docker-compose.yml:106` mounts the host's `/var/run/docker.sock` into `services/functions`. Simultaneously, `services/functions/src/runtime.ts` executes arbitrary tenant-submitted JavaScript using unsandboxed `child_process.execFile(process.execPath, ...)` without filesystem, network, or syscall isolation. Any tenant can execute arbitrary code on the host, interact with Docker daemon over the Unix socket, and achieve full root compromise.
2. **Artificial Microservice Sprawl ("Distributed Monolith"):** 9 microservices run across 9 Fastify servers, communicating via internal HTTP with HMAC-signed headers. All 9 services connect directly to the **exact same shared PostgreSQL database instance**, sharing identical table schemas and connection pools. This introduces massive network serialization overhead, cascading failure modes, and zero independent deployability.
3. **Database Concurrency Collapse:** Every read and write to tenant data under a principal takes a global PostgreSQL advisory transaction lock (`pg_advisory_xact_lock(hashtext(p_project_id::text))` in `002_enforcement.sql:195`) to maintain a synchronous hash chain in `audit_records`. Concurrency per project is strictly serialized to 1 operation at a time.
4. **N\*M Query Multiplication in Field Masking:** Dynamic masking views invoke `public.setu_field_visible(...)` for every column of every row. In a query returning 1,000 rows with 10 fields, Postgres executes 10,000 5-table subqueries, starving CPU.
5. **Argon2id Gateway Bottleneck:** The API Gateway executes synchronous `argon2id` key verification on **every single HTTP request** (`services/gateway/src/credentials.ts:79`) with zero caching, limiting single-core gateway throughput to ~20 requests per second.
6. **Phantom Infrastructure & Broken CI:** The repository claims NATS messaging, MinIO object storage, Kubernetes Helm charts, and Next.js Dashboard. In reality, NATS has 0 lines of calling code; MinIO is completely unwired (storage uses local disk `.storage`); Helm has no templates directory; `apps/dashboard` does not exist at all, causing CI Docker image builds to fail unconditionally. CI linting also fails immediately due to ESLint 9 configuration mismatch.

---

## 3. Top 5 Strengths

1. **Principled Data-Plane Enforcement:** Moving consent evaluation out of brittle application application code and into PostgreSQL RLS and transaction-scoped GUCs guarantees that even a buggy service cannot bypass tenant privacy policies.
2. **Strict Cryptographic Integrity Model:** Gateway HMAC request signing (`x-setu-sig`) prevents direct header spoofing across the internal network, ensuring downstream services fail closed if context is unsigned or forged.
3. **Immutability of Audit Records:** Append-only hash chaining with independent TypeScript verification (`services/audit/src/chain.ts`) provides tamper-evident audit logging for regulatory DPDP compliance.
4. **Clean Keyset Pagination & Opaque Denials:** keystone queries in `services/data/src/services/records.ts` use cursor-based keyset pagination and strictly opaque errors (404 for forbidden rows) to eliminate side-channel enumeration leaks.
5. **High Test Execution Discipline:** The core enforcement layer has 153 passing tests executing against real PostgreSQL instances with zero mocked DB calls.

---

## 4. Top 10 Weaknesses & Vulnerabilities

1. **Unsandboxed Functions Runtime + Docker Socket Mount:** Remote code execution / root host escape via tenant function deployment.
2. **Single-File Advisory Lock Serialization:** `pg_advisory_xact_lock` completely blocks concurrent operations per project.
3. **Gateway Argon2id CPU Starvation:** Synchronous CPU-intensive hashing per API call starves the Node.js event loop.
4. **Massive Phantom Infrastructure:** Unused NATS and MinIO containers running in Compose; non-existent Helm manifests; missing Next.js dashboard.
5. **Broken Client SDK:** `packages/sdk` calls non-existent routes (`/data/:table` instead of `/v1/collections/:name/records`) and does not work.
6. **In-Memory Buffer Storage:** File uploads/downloads load entire binaries into Node.js heap buffers in Base64 encoding.
7. **Connection Pool Depletion:** 9 services * 20 connections = 180+ connections, exceeding PostgreSQL default `max_connections` (100) on startup.
8. **Missing DB Uniqueness on Principals:** Race conditions in OTP authentication create duplicate principal records, breaking consent attribution.
9. **Unbuffered / Hanging Gateway Proxies:** Gateway `fetch` calls lack timeouts, circuit breakers, and streaming proxies.
10. **Broken CI Pipeline:** CI fails on `npm run lint` (ESLint 9 config missing) and `docker build` (missing `apps/dashboard`).

---

## 5. Strategic Roadmap Summary

- **Phase 0 (Days 1–7):** Revoke `/var/run/docker.sock` volume mount; fix CI by configuring ESLint 9 and removing phantom dashboard; stub SDK to prevent developer confusion.
- **Phase 1 (Weeks 1–4):** Consolidate the 9 microservices into a single **Modular Monolith** running in Fastify; eliminate internal HTTP hops and HMAC serialization; implement Redis/LRU cache for API key validation; introduce PgBouncer.
- **Phase 2 (Months 1–3):** Decouple audit logging into an asynchronous NATS queue with a dedicated batching audit worker (eliminating `pg_advisory_xact_lock` on the read/write hot path); implement proper microVM sandboxing (gVisor or Firecracker) for Functions.
- **Phase 3 (Months 3–6):** Optimize field masking using generated query-rewrite views or session-cached consent masks; implement genuine S3/MinIO streaming storage.
