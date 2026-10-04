# Setu Platform — Dead Code, Stale Files & Repository Hygiene Audit

## 1. Confirmed Dead / Obsolete Files

| File Path                                                           | Status               | Evidence                                                                                                   | Action                                            | Priority |
| :------------------------------------------------------------------ | :------------------- | :--------------------------------------------------------------------------------------------------------- | :------------------------------------------------ | :------- |
| `deploy/docker/dashboard.Dockerfile`                                | `CONFIRMED DEAD`     | References `apps/dashboard/package.json` which does not exist. Causes CI build failure.                    | Delete or stub until Dashboard exists             | P1       |
| `.semgrep/guardian.yml`                                             | `CONFIRMED OBSOLETE` | Contains an expired personal Semgrep auth token (`expiry: 2026-08-21`).                                    | Delete immediately                                | P2       |
| `.semgrep/guardian.yml.lock`                                        | `CONFIRMED OBSOLETE` | Lockfile for expired Semgrep token.                                                                        | Delete immediately                                | P2       |
| `services/*/__tests__/.gitkeep` (9 files)                           | `CONFIRMED OBSOLETE` | All 9 services have empty `__tests__` directories containing only `.gitkeep`. Real tests live in `tests/`. | Delete empty folders or move tests                | P3       |
| `packages/db/package.json:10` (`"migrate": "node dist/migrate.js"`) | `CONFIRMED DEAD`     | `packages/db` has no `migrate.ts` source file. Migrations are run via `scripts/migrate.mjs`.               | Update script to `node ../../scripts/migrate.mjs` | P3       |

---

## 2. Unwired / Phantom Infrastructure

| Component                     | Repository Location                                           | Declared Status                 | Real Code Status                                                                                       | Action                                                             |
| :---------------------------- | :------------------------------------------------------------ | :------------------------------ | :----------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------- |
| **NATS Message Broker**       | `docker-compose.yml:36-47`, `deploy/helm/setu/values.yaml:75` | "Messaging: NATS"               | 0 lines of client code connect to NATS across all services. Services wait for its healthcheck in vain. | Remove from default dev stack until M7 async worker is implemented |
| **MinIO Object Store**        | `docker-compose.yml:19-34`, `deploy/helm/setu/values.yaml:67` | "Object Storage: MinIO"         | `services/storage` writes directly to local disk `.storage`. MinIO runs as an idle container.          | Wire MinIO via S3 SDK or remove from local compose                 |
| **Next.js Dashboard**         | `README.md:55`, `docker-compose.yml:154`, `ci.yml:93`         | "M8 Dashboard"                  | `apps/dashboard` does not exist in the filesystem.                                                     | Remove service from compose and CI matrix                          |
| **Kubernetes Helm Templates** | `deploy/helm/setu/`                                           | "Kubernetes Helm charts"        | Contains only `Chart.yaml` and `values.yaml`. `templates/` directory is completely missing.            | Generate real deployment templates or remove placeholder chart     |
| **Terraform GCP Manifests**   | `README.md:60`                                                | "GCP infrastructure (optional)" | `deploy/terraform` directory does not exist.                                                           | Remove claim from README                                           |
