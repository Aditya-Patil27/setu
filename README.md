# Setu

**A DPDP-Compliant Backend-as-a-Service Platform for India**

Setu is a multi-tenant BaaS platform in which privacy compliance is a property of the data plane rather than of application code. Every data access carries a declared *purpose*, validated against a consent artifact and enforced inside PostgreSQL — row-level security for row visibility, generated masking views for field-level redaction — before any result reaches the application.

## Architecture

```
              ┌───────────────────────────────────────┐
              │     Console · JS SDK · MCP server     │
              └────────────────────┬──────────────────┘
                                   │ HTTPS
              ┌────────────────────▼──────────────────┐
              │           API GATEWAY (Fastify)       │
              │   tenant resolution + purpose binding │
              └──┬──────────┬──────────┬──────────┬───┘
                 │          │          │          │
            ┌────▼───┐ ┌────▼─────┐ ┌──▼──────┐ ┌─▼──────────┐
            │  Auth  │ │   Data   │ │ Storage │ │ Functions  │
            │Service │ │ Service  │ │ Service │ │  Runtime   │
            └────┬───┘ └────┬─────┘ └──┬──────┘ └─┬──────────┘
                 │          │          │          │
                 └──────────┴────┬─────┴──────────┘
                                 │
              ┌──────────────────▼────────────────────┐
              │      CONSENT & POLICY ENGINE          │
              └──────────────────┬────────────────────┘
                                 │
        ┌────────────┬───────────┼───────────┬──────────────┐
   ┌────▼─────┐ ┌────▼─────┐ ┌───▼────┐ ┌────▼─────────┐
   │ Postgres │ │  Object  │ │  NATS  │ │  Metering +  │
   │  (+RLS)  │ │  store   │ │(events)│ │ Audit Store  │
   └──────────┘ └──────────┘ └────────┘ └──────────────┘
```

## Repository Structure

```
setu/
├── packages/           # Shared libraries
│   ├── shared/         # Common types, utilities, constants
│   ├── db/             # Database client, migrations, schema
│   └── sdk/            # TypeScript client SDK
├── services/           # Microservices
│   ├── gateway/        # M1 — API Gateway
│   ├── auth/           # M2 — Auth Service
│   ├── consent/        # M3 — Consent & Policy Engine
│   ├── data/           # M4 — Data Service
│   ├── storage/        # M5 — Storage Service
│   ├── functions/      # M6 — Functions Runtime
│   ├── audit/          # M7 — Audit, Lineage & Metering
│   ├── metering/       # M7 — Metering Service
│   ├── workflow/       # M9 — Workflow Engine
│   └── ai/             # M10 — Consent-bound retrieval and inference
├── apps/
│   └── console/        # Static consent console (one HTML file, no build step)
├── deploy/
│   ├── docker/         # Dockerfiles per service
│   └── helm/           # Chart.yaml + values.yaml only — no templates yet
├── docs/
│   └── codebase-audit/ # Engineering audit and remediation plan
├── scripts/            # Dev tooling & automation
├── docker-compose.yml  # Local development stack
└── .github/workflows/  # CI/CD pipelines
```

## Quick Start

```bash
git clone <repo-url> && cd setu
npm install

# Bring up the stack
docker compose up --build

# Apply migrations, then seed a demo project. The seed prints an API key and a
# walkthrough: declare a collection, read one row under three purposes, attempt
# the bypass, run inference, revoke.
npm run db:migrate
npm run db:seed

# The same demo as one screen: three purposes side by side, revoke per column.
SETU_KEY=setu_... npm run console   # http://localhost:4000

# Tests run against a real PostgreSQL — no mocked database calls.
npm test
```

Point a coding agent at it instead:

```bash
claude mcp add setu   --env SETU_API_KEY=setu_...   --env SETU_PURPOSES=support_chat,analytics   -- npx -y @setu/mcp
```

The agent binds a purpose from a closed set fixed at configuration time, sees
only what that purpose is granted, and every call it makes lands in the audit
chain.

## Technology Stack

| Layer            | Technology                     | Status |
|------------------|--------------------------------|--------|
| Services         | TypeScript / Node.js (Fastify) | wired |
| Database         | PostgreSQL 16 + RLS            | wired |
| Vector storage   | pgvector                       | wired — M10 |
| Agent interface  | MCP over stdio                 | wired |
| Containers       | Docker + Compose               | wired |
| CI               | GitHub Actions                 | wired |
| Object storage   | Local filesystem               | seam — an S3-compatible store slots in behind an interface |
| Messaging        | NATS                           | seam — no-op publisher today, behind an interface |
| Orchestration    | Kubernetes (Helm)              | not started — chart has no templates |
| Observability    | Prometheus + Grafana           | not started |
| Cloud            | GCP asia-south1 (Mumbai)       | not started |

The seams are deliberate and documented at the call site: swapping the
filesystem object store for S3, or the no-op event publisher for NATS, touches
one file each. Compose still runs a NATS container. It no longer runs MinIO:
nothing read from it, and the `minio/minio` image stopped being pullable from
Docker Hub, which left `docker compose up` unable to start on a fresh machine.

## Modules

| #  | Module                    | Service Directory |
|----|---------------------------|-------------------|
| M1 | API Gateway               | `services/gateway`   |
| M2 | Auth Service              | `services/auth`      |
| M3 | Consent & Policy Engine   | `services/consent`   |
| M4 | Data Service              | `services/data`      |
| M5 | Storage Service           | `services/storage`   |
| M6 | Functions Runtime         | `services/functions` |
| M7 | Audit, Lineage & Metering | `services/audit`     |
| M8 | SDK + MCP server          | `packages/sdk`, `packages/mcp` |
| M9 | Workflow Engine           | `services/workflow`  |
| M10| Consent-bound inference   | `services/ai`        |

A Next.js dashboard was originally scoped as M8 and was never built. The
platform it would have called is finished and tested; `apps/console` is a
static page covering the demo, and the MCP server is the interface that
replaced the CLI idea.

## License

Private — Course project for MM0301A Cloud Computing, VIT Pune.
