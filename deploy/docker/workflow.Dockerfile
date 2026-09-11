# ── Build stage ─────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY services/workflow/package.json services/workflow/

RUN npm ci --include-workspace-root --workspace=@setu/workflow

COPY packages/shared/ packages/shared/
COPY packages/db/ packages/db/
COPY services/workflow/ services/workflow/
COPY tsconfig.base.json ./

RUN npm run build --workspace=@setu/shared && \
    npm run build --workspace=@setu/db && \
    npm run build --workspace=@setu/workflow

# ── Runtime stage ──────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/packages/shared/dist packages/shared/dist/
COPY --from=builder /app/packages/db/dist packages/db/dist/
COPY --from=builder /app/services/workflow/dist services/workflow/dist/
COPY --from=builder /app/services/workflow/package.json services/workflow/

EXPOSE 3007
CMD ["node", "services/workflow/dist/index.js"]
