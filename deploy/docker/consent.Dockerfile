# ── Build stage ─────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY services/consent/package.json services/consent/

RUN npm ci --workspace=@setu/consent

COPY packages/shared/ packages/shared/
COPY packages/db/ packages/db/
COPY services/consent/ services/consent/
COPY tsconfig.base.json ./

RUN npm run build --workspace=@setu/shared && \
    npm run build --workspace=@setu/db && \
    npm run build --workspace=@setu/consent

# ── Runtime stage ──────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/packages/shared/dist packages/shared/dist/
COPY --from=builder /app/packages/db/dist packages/db/dist/
COPY --from=builder /app/services/consent/dist services/consent/dist/
COPY --from=builder /app/services/consent/package.json services/consent/

EXPOSE 3005
CMD ["node", "services/consent/dist/index.js"]
