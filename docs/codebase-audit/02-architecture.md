# Setu Platform — Reverse-Engineered Architecture & System Design

## 1. Actual System Architecture

The following diagram illustrates the **actual** topology and data flow as implemented in code, stripping away the unverified documentation claims:

```mermaid
flowchart TD
    subgraph External["Client Layer"]
        Client["API Client / Webhook / External App"]
    end

    subgraph GatewayLayer["Perimeter (Single Entrypoint)"]
        GW["M1 Gateway (:3000)<br/>Fastify + @fastify/cors<br/>• Rate Limit (In-Memory TokenBucket)<br/>• Credential Resolution (Argon2id / Jose JWT)<br/>• Purpose Check against DB<br/>• HMAC-SHA256 Context Signing"]
    end

    subgraph InternalServices["Platform Microservices (Internal HTTP Network)"]
        Auth["M2 Auth (:3001)<br/>• API Keys<br/>• Mock/Log OTP<br/>• Refresh Tokens"]
        Consent["M3 Consent (:3005)<br/>• Purpose Registry<br/>• Consent Artifacts<br/>• In-Memory Event Log"]
        Data["M4 Data Plane (:3002)<br/>• Dynamic DDL Generator<br/>• Keyset Record Queries<br/>• Dynamic Masking View Projection"]
        Storage["M5 Storage (:3003)<br/>• Gated Metadata<br/>• Local FS Store (.storage)"]
        Functions["M6 Functions (:3004)<br/>• Node child_process execFile<br/>• Insecure /var/run/docker.sock Mount"]
        Audit["M7 Audit (:3006)<br/>• Hash-Chain Verification<br/>• Query Audit Records"]
        Workflow["M9 Workflow (:3007)<br/>• Sequential Step Claim & Lease<br/>• HTTP Invocation of M6"]
        Metering["M8/M7 Metering (:3008)<br/>• Closed Vocabulary Usage Tracking"]
    end

    subgraph DataStorage["Persistence & Shared State"]
        PG[(Single PostgreSQL 16 Instance)<br/>• pgvector + pgcrypto<br/>• Shared Tables (public.*)<br/>• Dynamic Tenant Schemas (s_<tenant>.*)<br/>• RLS Policies & Masking Views<br/>• Advisory Lock Serialization]
        Disk[("Local Host Filesystem (.storage)")<br/>Unencrypted Base64 Payloads]
    end

    subgraph Phantom["Phantom Infrastructure (Unwired / Unused)"]
        NATS["NATS Message Broker (:4222)<br/>0 Lines of Code Connected"]
        MinIO["MinIO S3 Store (:9000)<br/>0 Lines of Code Connected"]
        Dashboard["Next.js Dashboard (:3100)<br/>MISSING DIRECTORY"]
        Helm["Kubernetes Helm Chart<br/>NO TEMPLATES"]
    end

    Client -->|HTTPS Bearer Token| GW
    GW -->|DB Query: Key/JWT/Purpose| PG
    GW -->|HTTP + x-setu-sig| Auth
    GW -->|HTTP + x-setu-sig| Consent
    GW -->|HTTP + x-setu-sig| Data
    GW -->|HTTP + x-setu-sig| Storage
    GW -->|HTTP + x-setu-sig| Functions
    GW -->|HTTP + x-setu-sig| Audit
    GW -->|HTTP + x-setu-sig| Workflow
    GW -->|HTTP + x-setu-sig| Metering

    Workflow -->|HTTP Invoker| Functions
    Storage -->|Read/Write File| Disk

    Auth -->|Pool: setu_control| PG
    Consent -->|Pool: setu_control| PG
    Data -->|Pool 1: setu_runtime (NOBYPASSRLS)<br/>Pool 2: setu (Owner/DDL)| PG
    Storage -->|Pool: setu_control| PG
    Functions -->|Pool: setu_control| PG
    Audit -->|Pool: setu_runtime| PG
    Workflow -->|Pool: setu_control| PG
    Metering -->|Pool: setu_control| PG
```

---

## 2. Core Architectural Invariants & Data Flow

### 2.1 The Two-Gate Enforcement Mechanism

Setu's core thesis is: **"Privacy compliance is a property of the data plane, not of application code."**
Access to any personal data is constrained by two independent gates evaluated inside PostgreSQL:

- **Gate 1 (Tenant Policy):** The tenant must grant the declared purpose read access to the specific column (`field_purpose_grants`).
- **Gate 2 (Principal Consent):** The specific data subject must have an active, non-expired consent artifact covering that purpose and listing that field (`consent_artifacts`).

### 2.2 Row Visibility & Field Masking

- **Row Visibility:** Governed by `FORCE ROW LEVEL SECURITY` on collection tables in schema `s_<tenant>`. The `USING` and `WITH CHECK` clauses verify an active `consent_artifacts` record matching `app.purpose` and `app.project_id`.
- **Field Visibility:** Evaluated through dynamic masking views:
  `CREATE VIEW s_<tenant>.<collection>_masked WITH (security_invoker = true) AS SELECT ... CASE WHEN public.setu_field_visible(t.principal_id, '<cid>', '<field>', current_setting('app.purpose', true)) THEN t.field ELSE <mask_expr> END ...`

### 2.3 Cryptographic Request Context Binding

1. Client sends request to Gateway with `Authorization: Bearer <key|jwt>` and optional `x-setu-purpose: <purpose>`.
2. Gateway resolves identity, validates that the purpose exists in the database for that project, strips all incoming `x-setu-*` headers, and mints canonical context:
   `requestId|tenantId|projectId|principalId|purpose`
3. Gateway calculates HMAC-SHA256 signature using `INTERNAL_SIGNING_SECRET` and transmits `x-setu-sig` to upstream microservices.
4. Downstream services verify `x-setu-sig` via `timingSafeEqual` in `contextFromHeaders` before executing any query.
