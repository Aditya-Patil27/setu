# Setu

**A DPDP-Compliant Backend-as-a-Service Platform for India**

Setu is a multi-tenant BaaS platform in which privacy compliance is a property of the data plane rather than of application code. Every data access carries a declared *purpose*, validated against a consent artifact and enforced inside PostgreSQL — row-level security for row visibility, generated masking views for field-level redaction — before any result reaches the application.

## Architecture

```
              ┌───────────────────────────────────────┐
              │  Dashboard (Next.js) · CLI · JS SDK   │
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
   │ Postgres │ │  MinIO   │ │  NATS  │ │  Metering +  │
   │  (+RLS)  │ │(objects) │ │(events)│ │ Audit Store  │
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
│   └── workflow/       # M9 — Workflow Engine
├── apps/
│   └── dashboard/      # M8 — Next.js Dashboard
├── deploy/
│   ├── docker/         # Dockerfiles per service
│   ├── helm/           # Kubernetes Helm charts
│   └── terraform/      # GCP infrastructure (optional)
├── docs/
│   ├── api/            # OpenAPI specs
│   ├── architecture/   # Architecture decision records
│   └── guides/         # Developer & deployment guides
├── scripts/            # Dev tooling & automation
├── docker-compose.yml  # Local development stack
└── .github/workflows/  # CI/CD pipelines
```

## Quick Start

```bash
# Clone and install
git clone <repo-url> && cd setu
npm install

# Start local development stack
docker compose up --build

# Run tests
npm test
```

## Technology Stack

| Layer            | Technology                    |
|------------------|-------------------------------|
| Services         | TypeScript / Node.js (Fastify)|
| Database         | PostgreSQL 16 + RLS           |
| Vector Storage   | pgvector extension            |
| Object Storage   | MinIO (S3-compatible)         |
| Messaging        | NATS                          |
| Dashboard        | Next.js + React               |
| Containers       | Docker                        |
| Orchestration    | Kubernetes (Helm)             |
| CI/CD            | GitHub Actions                |
| Cloud            | GCP asia-south1 (Mumbai)      |
| Observability    | Prometheus + Grafana          |

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
| M8 | Dashboard, SDK, CLI       | `apps/dashboard`     |
| M9 | Workflow Engine           | `services/workflow`  |

## License

Private — Course project for MM0301A Cloud Computing, VIT Pune.
