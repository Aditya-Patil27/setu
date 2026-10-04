# ── Build stage ─────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY services/metering/package.json services/metering/

RUN npm ci --include-workspace-root --workspace=@setu/metering

COPY packages/shared/ packages/shared/
COPY packages/db/ packages/db/
COPY services/metering/ services/metering/
COPY tsconfig.base.json ./

RUN npm run build --workspace=@setu/shared && \
    npm run build --workspace=@setu/db && \
    npm run build --workspace=@setu/metering

# ── Runtime stage ──────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/packages/shared/dist packages/shared/dist/
COPY --from=builder /app/packages/db/dist packages/db/dist/
# node_modules/@setu/* are symlinks into packages/; without each manifest's
# "main", Node cannot resolve the package and the service exits on start.
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/db/package.json packages/db/
COPY --from=builder /app/services/metering/dist services/metering/dist/
COPY --from=builder /app/services/metering/package.json services/metering/

EXPOSE 3008
CMD ["node", "services/metering/dist/index.js"]
