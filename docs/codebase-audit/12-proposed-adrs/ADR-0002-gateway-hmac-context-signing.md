# ADR-0002: Perimeter Gateway with HMAC-SHA256 Request Context Signing

**Status:** Accepted
**Date:** 2026-08-21
**Deciders:** Principal Architect / Security Architect

## Context

In a multi-service architecture, internal services listen on network ports. If services rely on plaintext headers (such as `x-setu-purpose` or `x-setu-project-id`), any client or internal service able to connect over the network could spoof headers, assert arbitrary purposes, and trick the database into evaluating consent for unauthorized claims.

## Problem

How do downstream services verify that the `tenantId`, `projectId`, `principalId`, and `purpose` headers received on an HTTP request were authenticated and authorized by the perimeter API Gateway?

## Options Considered

### Option A: Mutual TLS (mTLS) with SPIFFE/SPIRE

- **Pros:** Cryptographic identity at the network transport layer; industry standard in service meshes.
- **Cons:** High operational overhead; requires service mesh infrastructure (Istio/Linkerd) that is excessive for small/medium deployments.

### Option B: Application-Layer HMAC-SHA256 Context Signing (Chosen)

- **Pros:** Lightweight; requires zero infrastructure changes; fast constant-time verification (`timingSafeEqual`); works across Docker, Kubernetes, and local development.
- **Cons:** Requires a shared secret (`INTERNAL_SIGNING_SECRET`) across all services; does not provide network-level mutual authentication.

## Decision

Adopt Option B. The Gateway strips all incoming `x-setu-*` headers, authenticates the client via API key or JWT, resolves the valid project and purpose, creates a canonical string `requestId|tenantId|projectId|principalId|purpose`, and computes an HMAC-SHA256 digest into `x-setu-sig`. Downstream services verify this signature before executing any business logic.

## Consequences

- No service trusts raw headers from callers.
- If a signature is invalid or absent, downstream services immediately return HTTP 401 Unauthorized.
- Internal service ports must NOT be published to the public internet in `docker-compose.yml` or Kubernetes Ingress.

## Revisit When

When transitioning to a service mesh in multi-cluster Kubernetes deployments or when consolidating services into a Modular Monolith (where in-process function calls replace HTTP headers entirely).
