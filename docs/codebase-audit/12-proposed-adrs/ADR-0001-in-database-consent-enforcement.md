# ADR-0001: In-Database Consent & Policy Enforcement via RLS & Dynamic Masking Views

**Status:** Accepted
**Date:** 2026-08-21
**Deciders:** Principal Architect / CTO

## Context

Setu is a multi-tenant Backend-as-a-Service designed for compliance with India's Digital Personal Data Protection (DPDP) Act. Applications built on Setu store sensitive personal data across multiple tenant collections. Under DPDP, data fiduciaries must ensure that personal data is processed solely for specific, agreed purposes, and that individuals can withdraw consent.

## Problem

In conventional architectures, authorization and privacy compliance are enforced in application code (middleware, controllers, or ORM hooks). If a service has a bug, is misconfigured, or is compromised, an attacker or application error can widen data access and leak protected data. How do we guarantee that no service or developer can bypass consent enforcement?

## Options Considered

### Option A: Application-Layer Middleware & Filter Interceptors

- **Pros:** Easy to implement; fast; avoids complex database triggers or views.
- **Cons:** Brittle; high blast radius if any service endpoint forgets to invoke the middleware; compromised service can bypass checks completely.

### Option B: In-Database RLS + Dynamic Masking Views with Transaction-Scoped GUCs (Chosen)

- **Pros:** Enforcement lives at the storage engine layer; superuser/bypass privileges are revoked (`setu_runtime: NOBYPASSRLS`); queries fail closed; dynamic views wrap non-permitted columns with masking strategies (`redact`, `partial`, `hash`, `null`).
- **Cons:** Query complexity increases; N*M evaluation overhead for `setu_field_visible` across large row scans.

## Decision

Adopt Option B. Every read and write statement must execute inside `withContext(pool, { projectId, purpose, principalId }, fn)` setting transaction-local GUCs (`app.project_id`, `app.purpose`, `app.principal_id`). Postgres RLS policies and `security_invoker = true` views enforce visibility natively.

## Consequences

- The database user connecting from data services cannot bypass RLS (`NOBYPASSRLS`).
- Application code cannot bypass purpose rules even if compromised.
- Keyset pagination must strictly avoid sorting or filtering on masked fields to prevent oracle leaks.
- Performance optimization is required for large result sets to avoid query multiplication.

## Revisit When

Scale exceeds 10,000 requests per second or when table sizes exceed 10 million rows per tenant, requiring compiled query-rewrite proxies or caching of consent evaluation matrices.
