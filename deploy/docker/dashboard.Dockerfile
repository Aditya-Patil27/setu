FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/dashboard/package.json apps/dashboard/

RUN npm ci --workspace=@setu/dashboard

COPY apps/dashboard/ apps/dashboard/

RUN npm run build --workspace=@setu/dashboard

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/apps/dashboard/.next apps/dashboard/.next/
COPY --from=builder /app/apps/dashboard/public apps/dashboard/public/
COPY --from=builder /app/apps/dashboard/package.json apps/dashboard/
COPY --from=builder /app/node_modules node_modules/

EXPOSE 3000
CMD ["npm", "start", "--workspace=@setu/dashboard"]
