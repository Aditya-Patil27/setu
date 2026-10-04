# ADR-0004: Consolidation from Distributed Microservices to Modular Monolith

**Status:** Proposed (Strategic Architecture Recommendation)
**Date:** 2026-09-11
**Deciders:** CTO / Staff Architect

## Context

Setu is structured into 9 separate microservices (`gateway`, `auth`, `consent`, `data`, `storage`, `functions`, `audit`, `metering`, `workflow`), each running a separate Fastify HTTP server. In practice, all 9 services connect directly to the **exact same PostgreSQL database** and share identical schemas and models.

## Problem

The microservice separation introduces substantial operational penalties:

1. **Connection Exhaustion:** 9 services * 20 connections = 180+ connections, causing Postgres connection pool depletion under default limits.
2. **Network & Serialization Overhead:** Every request requires multiple HTTP hops (Gateway -> Upstream, Workflow -> Functions -> Data), each serializing/deserializing JSON and verifying HMAC signatures.
3. **Deployment Complexity:** 9 Docker containers, multiple service networking rules, and complex local development orchestrations.
4. **No True Autonomy:** No service owns an independent database. Any schema change requires coordinated redeployment of multiple services.

## Options Considered

### Option A: True Microservices with Database-Per-Service

- **Pros:** Full independence of services.
- **Cons:** Destroys Setu's core value proposition: in-database RLS and dynamic masking views require `collection_definitions`, `purposes`, and `consent_artifacts` to reside in the **same PostgreSQL database engine** to perform atomic relational joins! Splitting databases would require distributed joins or RPCs, destroying performance.

### Option B: Maintain Current Distributed Monolith

- **Pros:** Familiar layout for current team.
- **Cons:** High operational overhead, connection leaks, slow request paths, and fragile HTTP signing seams.

### Option C: Consolidate into a Modular Monolith (Chosen)

- **Pros:**
  - Single deployable Fastify application with internal modular domain plugins (`@setu/auth`, `@setu/consent`, `@setu/data`, etc.).
  - Replaces internal HTTP hops and HMAC signature generation with in-process TypeScript function calls (`0ms` hop latency).
  - Single connection pool managed via PgBouncer.
  - Keeps all relational tables in the same PostgreSQL engine, maintaining the integrity of RLS and masking views.
  - Simplifies local development (`npm run dev` starts one process) and testing.
- **Cons:** Requires refactoring the Gateway proxy into in-process route dispatch.

## Decision

Adopt Option C. Consolidate the 9 microservices into a single modular Fastify monolith. Retain clear module boundaries using TypeScript project references and domain packages. Functions execution remains the only isolated component running in a dedicated sandboxed worker process.

## Consequences

- Single container image to build and deploy in CI/CD.
- Drastic reduction in memory footprint, CPU utilization, and inter-service latency.
- Solves the database connection saturation problem permanently.
