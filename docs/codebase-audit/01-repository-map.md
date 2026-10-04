# Setu Platform — Repository Topology & System Map

## 1. Physical Repository Structure

```text
setu/
├── .claude/                             # Claude developer settings
│   └── settings.local.json              # Local developer environment permissions
├── .claude-flow/                        # Claude-flow harness state
├── .github/
│   └── workflows/
│       └── ci.yml                       # GitHub Actions CI pipeline (broken)
├── .semgrep/
│   ├── guardian.yml                     # Accidental committed Semgrep auth token
│   └── guardian.yml.lock                # Lockfile for Semgrep
├── deploy/
│   ├── docker/                          # Dockerfiles per service
│   │   ├── audit.Dockerfile
│   │   ├── auth.Dockerfile
│   │   ├── consent.Dockerfile
│   │   ├── dashboard.Dockerfile         # Broken: builds missing apps/dashboard
│   │   ├── data.Dockerfile
│   │   ├── functions.Dockerfile
│   │   ├── gateway.Dockerfile
│   │   ├── metering.Dockerfile
│   │   ├── storage.Dockerfile
│   │   └── workflow.Dockerfile
│   └── helm/
│       └── setu/
│           ├── Chart.yaml               # Helm chart definition
│           └── values.yaml              # Chart values (NO TEMPLATES EXIST)
├── docs/
│   ├── superpowers/
│   │   └── specs/
│   │       └── 2026-08-21-setu-enforcement-spine-design.md # Core enforcement spec
│   └── codebase-audit/                  # This comprehensive FAANG CTO audit
├── packages/                            # Monorepo shared libraries (npm workspaces)
│   ├── db/                              # Database abstraction & migration runner
│   │   ├── migrations/
│   │   │   ├── 001_init.sql             # Base platform schema
│   │   │   ├── 002_enforcement.sql      # RLS, roles, audit functions, metadata
│   │   │   ├── 003_storage.sql          # Object storage RLS & metadata
│   │   │   ├── 004_metering.sql         # Usage records & constraints
│   │   │   ├── 005_functions.sql        # Function definitions & execution tracking
│   │   │   └── 006_workflow.sql         # Workflow steps & lease states
│   │   ├── src/
│   │   │   ├── context.ts               # Transaction-scoped GUC runner (withContext)
│   │   │   ├── index.ts                 # Package entrypoint
│   │   │   └── pool.ts                  # Multi-role connection pool factory
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── sdk/                             # TypeScript client SDK (broken/stub)
│   │   ├── src/
│   │   │   ├── client.ts                # Fluent query builder (broken API paths)
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── shared/                          # Common contracts, errors, and validation
│       ├── src/
│       │   ├── constants.ts             # Headers, service names, events
│       │   ├── context.ts               # HMAC signing, canonicalization, parsing
│       │   ├── errors.ts                # Structured domain errors (SetuError hierarchy)
│       │   ├── index.ts
│       │   ├── types/index.ts           # Core domain interfaces
│       │   ├── utils/index.ts
│       │   └── validate.ts              # Zod input validation wrapper
│       ├── package.json
│       └── tsconfig.json
├── scripts/
│   ├── migrate.mjs                      # Standalone migration runner (postgres-migrations)
│   └── seed.mjs                         # Demonstration tenant & consent seeder
├── services/                            # Node.js Fastify Microservices
│   ├── audit/                           # M7 — Audit Log & Hash-Chain Verification
│   │   └── src/
│   │       ├── app.ts                   # Fastify server bootstrap
│   │       ├── chain.ts                 # Client-side hash-chain walker & verification
│   │       ├── db.ts                    # Service DB pool wiring
│   │       ├── index.ts                 # CLI entrypoint (:3006)
│   │       └── routes/index.ts          # Audit retrieval & verification endpoints
│   ├── auth/                            # M2 — Authentication & Identity
│   │   └── src/
│   │       ├── app.ts                   # Fastify server bootstrap
│   │       ├── db.ts                    # Service DB pool wiring
│   │       ├── index.ts                 # CLI entrypoint (:3001)
│   │       ├── otp.ts                   # OTP generation & mock provider
│   │       ├── tokens.ts                # JWT issuance (jose) & refresh token rotation
│   │       └── routes/
│   │           ├── index.ts
│   │           ├── keys.ts              # API key CRUD (Argon2id)
│   │           └── sessions.ts          # OTP challenge/verify & token refresh
│   ├── consent/                         # M3 — Consent & Purpose Policy Engine
│   │   └── src/
│   │       ├── app.ts                   # Fastify server bootstrap
│   │       ├── db.ts                    # Service DB pool wiring
│   │       ├── events.ts                # Logging/mock event publisher (no NATS)
│   │       ├── index.ts                 # CLI entrypoint (:3005)
│   │       └── routes/
│   │           ├── consents.ts          # Consent artifact CRUD & advisory checks
│   │           ├── index.ts
│   │           ├── me.ts                # Principal self-service consent inspection
│   │           └── purposes.ts          # Purpose registry management
│   ├── data/                            # M4 — Data Plane & Dynamic Collections
│   │   └── src/
│   │       ├── app.ts                   # Fastify server bootstrap
│   │       ├── db.ts                    # Dual-pool wiring (runtime NOBYPASSRLS + owner)
│   │       ├── ddl/
│   │       │   ├── collections.ts       # Collection creation orchestrator
│   │       │   ├── generate.ts          # SQL DDL & masking view compiler
│   │       │   └── identifiers.ts       # Identifier validation & SQL quoting
│   │       ├── index.ts                 # CLI entrypoint (:3002)
│   │       ├── routes/
│   │       │   ├── collections.ts       # Collection definition endpoints
│   │       │   ├── index.ts
│   │       │   └── records.ts           # Record CRUD HTTP routing
│   │       └── services/
│   │           ├── audit.ts             # Direct SQL denial & access logging
│   │           └── records.ts           # Query compiler, keyset pagination, filters
│   ├── functions/                       # M6 — Serverless Functions Runtime
│   │   └── src/
│   │       ├── app.ts                   # Fastify server bootstrap
│   │       ├── db.ts                    # Service DB pool wiring
│   │       ├── index.ts                 # CLI entrypoint (:3004)
│   │       ├── routes/index.ts          # Function CRUD & invoke routes
│   │       └── runtime.ts               # Unsandboxed Node child_process runner
│   ├── gateway/                         # M1 — API Gateway & Context Signer
│   │   └── src/
│   │       ├── app.ts                   # Fastify server bootstrap & CORS
│   │       ├── credentials.ts           # In-line Argon2 key verify & JWT decoder
│   │       ├── db.ts                    # Service DB pool wiring
│   │       ├── index.ts                 # CLI entrypoint (:3000)
│   │       ├── ratelimit.ts             # In-memory Token Bucket rate limiter
│   │       ├── routes/index.ts          # Proxy reverse router & header signer
│   │       └── upstreams.ts             # Upstream URL mapping & purpose rules
│   ├── metering/                        # M8/M7 — Usage Metering Service
│   │   └── src/
│   │       ├── app.ts                   # Fastify server bootstrap
│   │       ├── db.ts                    # Service DB pool wiring
│   │       ├── index.ts                 # CLI entrypoint (:3008)
│   │       ├── meters.ts                # Closed vocabulary validation
│   │       └── routes/index.ts          # Meter recording & aggregation queries
│   ├── storage/                         # M5 — Object Storage
│   │   └── src/
│   │       ├── app.ts                   # Fastify server bootstrap
│   │       ├── db.ts                    # Service DB pool wiring
│   │       ├── index.ts                 # CLI entrypoint (:3003)
│   │       ├── routes/index.ts          # Gated object upload/download endpoints
│   │       └── store.ts                 # Local filesystem store (.storage)
│   └── workflow/                        # M9 — Durable Sequential Workflow Engine
│       └── src/
│           ├── app.ts                   # Fastify server bootstrap
│           ├── db.ts                    # Service DB pool wiring
│           ├── engine.ts                # Step claiming, leasing, and state transitions
│           ├── index.ts                 # CLI entrypoint (:3007)
│           ├── invoker.ts               # HTTP invoker for Functions
│           └── routes/index.ts          # Workflow definition & run loop
├── tests/                               # Centralized Integration Test Suites
│   ├── cross-service/
│   │   └── gateway.test.ts              # E2E Gateway -> Data proxy test
│   ├── enforcement/
│   │   └── foundation.test.ts           # Postgres role NOBYPASSRLS verification
│   ├── helpers/
│   │   ├── env.ts                       # Test database environment loader
│   │   ├── fixtures.ts                  # Schema isolation, user & project creation
│   │   └── http.ts                      # HTTP test helpers
│   ├── services/                        # Service-level integration tests (pg-backed)
│   │   ├── audit.test.ts
│   │   ├── auth.test.ts
│   │   ├── consent.test.ts
│   │   ├── data.test.ts
│   │   ├── functions.test.ts
│   │   ├── metering.test.ts
│   │   ├── storage.test.ts
│   │   └── workflow.test.ts
│   └── global-setup.ts                  # Vitest global DB creation & migration
├── .env                                 # Active development environment config
├── .env.example                         # Environment configuration template
├── .gitignore                           # Git ignore list
├── docker-compose.yml                   # Local Docker stack definition
├── package.json                         # Root package.json (monorepo root)
├── package-lock.json                    # Monorepo lockfile
├── README.md                            # High-level architecture documentation
├── tsconfig.base.json                   # Shared TypeScript compiler options
├── tsconfig.json                        # Monorepo root TypeScript project references
└── vitest.config.ts                     # Vitest test runner configuration
```

---

## 2. Monorepo vs. Monolith Classification

### Architecture Classification: **Distributed Monolith (Microservices Anti-Pattern)**

Setu presents itself structurally as a **monorepo of microservices** (9 distinct service directories, 9 Dockerfiles, 9 HTTP ports). However, architecturally, it functions as a **distributed monolith**:

1. **Shared Single-Instance Database:** Every single service connects directly to the **exact same PostgreSQL database**, reading and writing shared tables (e.g. `services/data` reads `purposes` and `consent_artifacts` directly; `services/auth` writes `principals` directly; `services/functions` writes `purposes` and `function_definitions`; `services/workflow` queries `purposes`).
2. **Coupled Database Schemas & Migrations:** There is only one set of migrations in `packages/db/migrations`. No service owns its own data store or schema.
3. **Synchronous Internal HTTP Call Chains:**
   `Client -> Gateway (:3000) -> HTTP Internal -> Data (:3002) -> PostgreSQL`
   `Workflow (:3007) -> HTTP Internal -> Functions (:3004) -> Subprocess -> Data (:3002)`
4. **Shared Internal Secrets:** All services must share the identical `INTERNAL_SIGNING_SECRET` and database credentials.
5. **Zero Independent Deployability:** Changes to database functions (`setu_field_visible`, `setu_append_audit`) or metadata schemas require simultaneous coordination across all services.

**Conclusion:** The codebase pays the operational penalty of microservices (network serialization, latency amplification, deployment complexity, distributed debugging friction) without receiving any of the architectural benefits (isolated databases, independent scaling, technology diversity, bounded contexts).
