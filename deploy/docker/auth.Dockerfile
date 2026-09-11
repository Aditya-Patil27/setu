# ── Build stage ─────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY services/auth/package.json services/auth/

RUN npm ci --include-workspace-root --workspace=@setu/auth

COPY packages/shared/ packages/shared/
COPY packages/db/ packages/db/
COPY services/auth/ services/auth/
COPY tsconfig.base.json ./

RUN npm run build --workspace=@setu/shared && \
    npm run build --workspace=@setu/db && \
    npm run build --workspace=@setu/auth

# ── Runtime stage ──────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/packages/shared/dist packages/shared/dist/
COPY --from=builder /app/packages/db/dist packages/db/dist/
COPY --from=builder /app/services/auth/dist services/auth/dist/
COPY --from=builder /app/services/auth/package.json services/auth/

EXPOSE 3001
CMD ["node", "services/auth/dist/index.js"]
