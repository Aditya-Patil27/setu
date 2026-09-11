# ── Build stage ─────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY services/audit/package.json services/audit/

RUN npm ci --include-workspace-root --workspace=@setu/audit

COPY packages/shared/ packages/shared/
COPY packages/db/ packages/db/
COPY services/audit/ services/audit/
COPY tsconfig.base.json ./

RUN npm run build --workspace=@setu/shared && \
    npm run build --workspace=@setu/db && \
    npm run build --workspace=@setu/audit

# ── Runtime stage ──────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/packages/shared/dist packages/shared/dist/
COPY --from=builder /app/packages/db/dist packages/db/dist/
COPY --from=builder /app/services/audit/dist services/audit/dist/
COPY --from=builder /app/services/audit/package.json services/audit/

EXPOSE 3006
CMD ["node", "services/audit/dist/index.js"]
