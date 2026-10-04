# Setu Platform — Architecture Decision Record (ADR) Audit

## 1. Existing ADR Audit

- **Searched Locations:** `docs/architecture/`, `docs/adrs/`, `docs/decisions/`, `packages/*/`, `services/*/`
- **Result:** **ZERO FORMAL ADRs EXIST.**
- **Finding:** The repository completely lacks an ADR directory. The sole architectural document is `docs/superpowers/specs/2026-08-21-setu-enforcement-spine-design.md`, which contains informal decision tables but no structured ADRs tracking decision status, alternatives considered, consequences, or supersession history.

---

## 2. Missing ADR Register & Recommendations

The following core architectural decisions exist in code but have no formal ADR. We propose 4 foundational ADRs in `docs/codebase-audit/12-proposed-adrs/`:

1. **ADR-0001: In-Database Consent & Policy Enforcement via RLS & Dynamic Masking Views**
   - Documents the foundational decision to push DPDP consent evaluation into PostgreSQL instead of application code.
2. **ADR-0002: Perimeter Gateway with HMAC-SHA256 Request Context Signing**
   - Documents the decision to use the API Gateway to bind purposes and sign context headers (`x-setu-sig`) for internal services.
3. **ADR-0003: Sandboxed Execution Runtime for Tenant Functions**
   - Formulates the decision to replace unsandboxed child processes and docker socket mounts with isolated microVMs / WebAssembly.
4. **ADR-0004: Consolidation from Distributed Microservices to Modular Monolith**
   - Proposes superseding the 9-microservice topology with a unified, high-throughput modular monolith sharing in-process context.
