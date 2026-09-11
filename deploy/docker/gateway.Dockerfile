# ── Build stage ─────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY services/gateway/package.json services/gateway/

RUN npm ci --include-workspace-root --workspace=@setu/gateway

COPY packages/shared/ packages/shared/
COPY packages/db/ packages/db/
COPY services/gateway/ services/gateway/
COPY tsconfig.base.json ./

RUN npm run build --workspace=@setu/shared && \
    npm run build --workspace=@setu/db && \
    npm run build --workspace=@setu/gateway

# ── Runtime stage ──────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/packages/shared/dist packages/shared/dist/
COPY --from=builder /app/packages/db/dist packages/db/dist/
COPY --from=builder /app/services/gateway/dist services/gateway/dist/
COPY --from=builder /app/services/gateway/package.json services/gateway/

EXPOSE 3000
CMD ["node", "services/gateway/dist/index.js"]
