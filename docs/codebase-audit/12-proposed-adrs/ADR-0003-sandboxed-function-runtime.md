# ADR-0003: Sandboxed Execution Runtime for Tenant Functions

**Status:** Proposed (Emergency P0 Migration)
**Date:** 2026-09-11
**Deciders:** CTO / Security Architect / Platform Lead

## Context

Setu's M6 Functions service (`services/functions`) enables tenants to define serverless JavaScript functions that execute alongside data processing workflows. In the initial implementation (`services/functions/src/runtime.ts`), tenant functions are run via `child_process.execFile` directly on the host Node.js environment, while `docker-compose.yml` mounts the host's `/var/run/docker.sock` into the container.

## Problem

Running unsandboxed tenant code with access to the host's Docker socket constitutes an immediate Remote Code Execution (RCE) and container escape vulnerability. Tenant code can compromise the host machine, bypass network boundaries, access internal microservices, and steal database credentials.

## Options Considered

### Option A: Node.js `worker_threads` or `vm2`

- **Pros:** Fast startup times, minimal dependencies.
- **Cons:** Fundamentally insecure. `vm2` has had numerous sandbox breakout CVEs and is deprecated; `worker_threads` provides zero OS isolation.

### Option B: Container-per-Invocation (Docker-in-Docker via Docker Socket)

- **Pros:** Uses standard Docker containers.
- **Cons:** Severe security risk of mounting `/var/run/docker.sock`; slow container startup times (~500ms–2s per invocation); high resource consumption.

### Option C: Virtualized Micro-Sandboxing via WebAssembly (Wasmtime / V8 Isolate / workerd) or gVisor (Chosen)

- **Pros:** True memory and system-call isolation. Sub-millisecond cold starts (Wasm/Isolates); zero access to host filesystem, network, or Docker socket.
- **Cons:** Requires restriction of tenant code to JavaScript standard APIs without native Node.js OS modules.

## Decision

Adopt Option C. Immediately remove `/var/run/docker.sock` from all container definitions. Replace `child_process.execFile` with an isolated V8 isolate runtime (e.g., Cloudflare Workerd, `isolated-vm`, or Wasmtime). Restrict system calls, block outbound raw network sockets, and enforce hard execution memory and CPU ceilings.

## Consequences

- Total host compromise vector is permanently eliminated.
- Function execution overhead drops from process spawning (~50ms) to isolate creation (<5ms).
- Functions cannot access Node.js native filesystem or Docker APIs.
