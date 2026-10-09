# syntax=docker/dockerfile:1
# One file, one target per app: docker build --target api|worker|web .

FROM node:22-alpine AS base
WORKDIR /repo
# Every workspace manifest is needed for npm to install any one of them.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/queue/package.json packages/queue/
COPY packages/collectors/package.json packages/collectors/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/

FROM base AS build
RUN npm ci
COPY tsconfig.base.json tsup.preset.ts ./
COPY packages packages
COPY apps apps
RUN npm run build -w @lp/api -w @lp/worker -w @lp/web

# Production dependencies only, per app. Workspace code is bundled into dist, so only npm packages are needed.
FROM base AS api-deps
RUN npm ci --omit=dev -w @lp/api && npm cache clean --force

FROM base AS worker-deps
RUN npm ci --omit=dev -w @lp/worker && npm cache clean --force

FROM node:22-alpine AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-deps /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/packages/db/drizzle ./drizzle
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]

FROM node:22-alpine AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=worker-deps /repo/node_modules ./node_modules
COPY --from=build /repo/apps/worker/dist ./dist
USER node
CMD ["node", "dist/index.js"]

FROM node:22-alpine AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# Standalone output mirrors the monorepo layout, so the server lives at apps/web/server.js.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
