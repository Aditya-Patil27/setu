# ── Build stage ─────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY services/data/package.json services/data/

RUN npm ci --workspace=@setu/data

COPY packages/shared/ packages/shared/
COPY packages/db/ packages/db/
COPY services/data/ services/data/
COPY tsconfig.base.json ./

RUN npm run build --workspace=@setu/shared && \
    npm run build --workspace=@setu/db && \
    npm run build --workspace=@setu/data

# ── Runtime stage ──────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/packages/shared/dist packages/shared/dist/
COPY --from=builder /app/packages/db/dist packages/db/dist/
COPY --from=builder /app/services/data/dist services/data/dist/
COPY --from=builder /app/services/data/package.json services/data/

EXPOSE 3002
CMD ["node", "services/data/dist/index.js"]
