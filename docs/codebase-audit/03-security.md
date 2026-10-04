# Setu Platform — Security & Cryptographic Audit

## 1. Threat Modeling & Vulnerability Findings

### [P0 - CRITICAL] Remote Code Execution & Container Breakout via Insecure Functions Runtime + Docker Socket Mount

- **Location:** `docker-compose.yml:106`, `services/functions/src/runtime.ts:121-154`, `services/functions/src/routes/index.ts:38`
- **Category:** Remote Code Execution / Host Compromise / Sandbox Escape
- **Evidence:**
  `docker-compose.yml:106`:
  ```yaml
  functions:
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock # for spawning function containers
  ```
  `services/functions/src/runtime.ts:121-128`:
  ```ts
  const child = execFile(
    process.execPath,
    [`--max-old-space-size=${req.memoryMb}`, join(dir, 'run.mjs'), join(dir, 'payload.json')],
    {
      cwd: dir,
      timeout: req.timeoutMs,
      env: { NODE_ENV: 'production', PATH: process.env.PATH ?? '' },
    },
  );
  ```
- **Problem:** Any tenant with a project API key can upload arbitrary JavaScript via `POST /v1/functions` and invoke it via `POST /v1/functions/:name/invoke`. The runtime author acknowledges in `runtime.ts:91-95`:
  _"What it is NOT is a security sandbox. There is no syscall filtering, no filesystem jail and no network restriction..."_
  Because `/var/run/docker.sock` is mounted into the container, any tenant function can import `node:http` or `node:net`, connect to `/var/run/docker.sock`, and command the host's Docker daemon to run a privileged container with `/` mounted from the host filesystem.
- **Risk:** Complete host root compromise, theft of all tenant databases, lateral movement across host networks, and arbitrary data exfiltration.
- **Remediation:**
  1. Immediately delete the `/var/run/docker.sock` volume mount in `docker-compose.yml`.
  2. Implement a genuine virtualized execution sandbox (e.g. gVisor `runsc`, Firecracker microVMs, or WebAssembly micro-runtimes like Wasmtime / Cloudflare Workerd).
- **Priority:** P0 (Immediate Emergency Fix) | Effort: M | Confidence: High

---

### [P1 - HIGH] Race Condition Generating Duplicate Principals & Fragmenting Consent

- **Location:** `services/auth/src/routes/sessions.ts:120-132`, `packages/db/migrations/001_init.sql:33-41`
- **Category:** Authentication Integrity & Data Isolation
- **Evidence:**
  `packages/db/migrations/001_init.sql`:
  ```sql
  CREATE TABLE IF NOT EXISTS principals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      phone TEXT,
      email TEXT,
      display_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ```
  There is NO `UNIQUE (project_id, phone)` or `UNIQUE (project_id, email)` constraint.
  In `services/auth/src/routes/sessions.ts:120-132`:
  ```ts
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM principals WHERE project_id = $1 AND ${column} = $2`,
    [ctx.projectId, challenge.destination],
  );
  const principalId = existing.rowCount
    ? existing.rows[0].id
    : (
        await client.query<{ id: string }>(
          `INSERT INTO principals (project_id, ${column}) VALUES ($1, $2) RETURNING id`,
          [ctx.projectId, challenge.destination],
        )
      ).rows[0].id;
  ```
- **Problem:** If two concurrent requests verify OTP for the same phone/email simultaneously, both pass the `SELECT` check and both perform `INSERT INTO principals`. This creates duplicate `principal_id` rows for the same human user.
- **Why it matters:** Consent artifacts (`consent_artifacts`) and row data (`principal_id`) are linked to UUIDs. If a user logs in and gets `principal_id_A`, grants consent, and later logs in on another device and races or gets `principal_id_B`, their consent state is fragmented. If they revoke consent on one principal ID, records under the second principal ID remain accessible. This is a direct violation of DPDP statutory consent obligations.
- **Remediation:** Add unique partial indexes:
  `CREATE UNIQUE INDEX idx_principals_phone ON principals(project_id, phone) WHERE phone IS NOT NULL;`
  `CREATE UNIQUE INDEX idx_principals_email ON principals(project_id, email) WHERE email IS NOT NULL;`
  Use `INSERT ... ON CONFLICT (project_id, phone) DO UPDATE SET updated_at = now() RETURNING id;`.
- **Priority:** P1 | Effort: S | Confidence: High

---

### [P2 - HIGH] Denial of Service via Synchronous Uncached Argon2id Key Verification on Gateway

- **Location:** `services/gateway/src/credentials.ts:79`
- **Category:** Availability / Denial of Service
- **Evidence:**
  ```ts
  const ok = await argonVerify(row.key_hash, secret).catch(() => false);
  ```
- **Problem:** Argon2id is intentionally designed to be slow and CPU-intensive (~50ms of intense CPU hashing per execution). Setu runs `argonVerify` synchronously on **every single inbound HTTP request** bearing an API key.
- **Risk:** At 20 requests per second, 100% of a CPU core is consumed exclusively calculating Argon2 hashes. Under 50 RPS, the Node.js event loop freezes, queuing inbound requests, leading to gateway timeouts (504/502).
- **Remediation:** Hash API keys using SHA-256 over high-entropy tokens (e.g., 256-bit random keys `setu_<prefix>_<high_entropy_secret>`) which can be verified in sub-millisecond time, or cache verified key hashes in a secure in-memory LRU cache / Redis with a 60-second TTL.
- **Priority:** P1 | Effort: S | Confidence: High

---

### [P2 - HIGH] Permissive Default CORS Configuration

- **Location:** `services/gateway/src/app.ts:41`
- **Evidence:**
  ```ts
  await app.register(cors);
  ```
- **Problem:** `@fastify/cors` registered without parameters defaults to `Access-Control-Allow-Origin: *` and reflection of origins.
- **Risk:** Any arbitrary malicious web application in an authenticated user's browser can interact with the Setu API Gateway if credentials (JWT cookies or exposed tokens) are available.
- **Remediation:** Restrict CORS allowed origins to tenant configured domain allowlists.
- **Priority:** P2 | Effort: S | Confidence: High

---

### [P3 - MEDIUM] In-Memory Unbounded File Storage Buffers & Missing Encryption at Rest

- **Location:** `services/storage/src/routes/index.ts:45,95`, `services/storage/src/store.ts:71`
- **Evidence:**
  `services/storage/src/routes/index.ts:45`:
  `content: z.string().max(Math.ceil(MAX_BYTES / 3) * 4)`
  `services/storage/src/store.ts:71`:
  `await writeFile(path, body);`
- **Problem:** Files are accepted only as Base64 JSON strings and stored as unencrypted raw files in the `.storage` directory. `001_init.sql:180` defines `encrypted_at_rest BOOLEAN NOT NULL DEFAULT true`, but no encryption is actually performed.
- **Risk:** High memory consumption on upload/download; files on disk are unencrypted personal data, violating DPDP security safeguard rules.
- **Remediation:** Stream uploads directly to S3/MinIO using presigned URLs or multipart streams, and apply AES-256 envelope encryption.
- **Priority:** P2 | Effort: M | Confidence: High
