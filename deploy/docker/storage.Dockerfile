# ── Build stage ─────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY services/storage/package.json services/storage/

RUN npm ci --workspace=@setu/storage

COPY packages/shared/ packages/shared/
COPY packages/db/ packages/db/
COPY services/storage/ services/storage/
COPY tsconfig.base.json ./

RUN npm run build --workspace=@setu/shared && \
    npm run build --workspace=@setu/db && \
    npm run build --workspace=@setu/storage

# ── Runtime stage ──────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/packages/shared/dist packages/shared/dist/
COPY --from=builder /app/packages/db/dist packages/db/dist/
COPY --from=builder /app/services/storage/dist services/storage/dist/
COPY --from=builder /app/services/storage/package.json services/storage/

EXPOSE 3003
CMD ["node", "services/storage/dist/index.js"]
