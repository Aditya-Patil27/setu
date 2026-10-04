# Setu Platform — Dependency & Supply Chain Audit

## 1. Direct Dependency Inventory

| Package               | Version   | Layer / Service        | Purpose                     | Criticality | Risk Assessment & Recommendation                                                                                                                                                                |
| :-------------------- | :-------- | :--------------------- | :-------------------------- | :---------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fastify`             | `^5.0.0`  | Services (all 9)       | Web framework               | Critical    | **Current & High Performance.** Maintain; excellent choice for Node.js microservices.                                                                                                           |
| `@fastify/cors`       | `^10.0.0` | Gateway & Services     | CORS handling               | Medium      | **Configuration Risk.** Defaults to wildcard `*`; must be restricted with explicit origin allowlist.                                                                                            |
| `@node-rs/argon2`     | `^2.0.0`  | Gateway, Auth, Scripts | Password & API key hashing  | Critical    | **Performance Bottleneck.** Native Rust binding is fast, but Argon2id is inappropriate for per-request API key validation on the gateway. Migrate API keys to SHA-256 with high-entropy tokens. |
| `jose`                | `^5.9.0`  | Gateway, Auth          | JWT signing & verification  | High        | **Standard & High Quality.** Modern zero-dependency JOSE implementation. Well-suited for JWT verification.                                                                                      |
| `pg`                  | `^8.13.0` | DB, Services, Scripts  | PostgreSQL client           | Critical    | **Solid Foundation.** Standard Node.js Postgres driver. Pool size configurations need tuning and integration with PgBouncer.                                                                    |
| `postgres-migrations` | `^5.3.0`  | DB, Scripts            | Migration runner            | High        | **Functional.** Handles SQL-based schema migrations cleanly.                                                                                                                                    |
| `zod`                 | `^3.24.0` | Shared, Services       | Schema validation           | Critical    | **Industry Standard.** Enforces strict type validation at HTTP boundaries via `parseInput`.                                                                                                     |
| `typescript`          | `^5.7.0`  | Root devDependency     | Type checking & compilation | High        | **Current.** Monorepo project references configured cleanly via `tsconfig.json`.                                                                                                                |
| `vitest`              | `^3.0.0`  | Root devDependency     | Unit & integration testing  | High        | **High Velocity.** Extremely fast test runner with native TypeScript support via Vite.                                                                                                          |
| `eslint`              | `^9.0.0`  | Root devDependency     | Linting                     | Medium      | **Broken in CI.** Upgraded to v9 without creating an `eslint.config.js` flat config file, causing CI failures.                                                                                  |
| `prettier`            | `^3.4.0`  | Root devDependency     | Code formatting             | Low         | **Failing check.** Needs a one-time automated run `npm run format`.                                                                                                                             |
| `tsx`                 | `^4.19.0` | Dev runner             | TypeScript execution        | Medium      | **Developer Tool.** Used for dev watch mode (`tsx watch src/index.ts`).                                                                                                                         |
| `rimraf`              | `^6.0.0`  | Monorepo root          | Build cleanup               | Low         | Cross-platform directory deletion utility.                                                                                                                                                      |

---

## 2. Supply Chain & Tooling Issues

1. **Missing Lockfile for Docker Builds:** Dockerfiles run `RUN npm ci --workspace=...` copying only root `package.json` and individual package manifests without always scoping package-lock appropriately.
2. **Missing Dependencies Claimed in Documentation:**
   - `nats.js` is declared in architecture docs but absent from `package.json`.
   - `minio` or `@aws-sdk/client-s3` is claimed for object storage but absent from `services/storage/package.json`.
   - `@opentelemetry/*` or `prom-client` is claimed for observability but absent from dependencies.
3. **Workspace Inconsistencies:** `packages/sdk` and `packages/shared` use `"dependencies": { "@setu/shared": "*" }`. While valid in npm workspaces, explicit version references or `workspace:*` syntax is preferred for publishing safety.
