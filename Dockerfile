# syntax=docker/dockerfile:1
# Multi-stage build. Jenkins only has Docker (no Node), so the quality gates run inside `docker build`:
#   docker build --target test .                                   # typecheck + lint + format + unit tests
#   docker build --target runtime -t akon47/file-share:<tag> --build-arg APP_VERSION=<tag> .
# glibc (bookworm) rather than alpine: the Jenkins VM's kvm64 vCPU lacks SSE4.1 and musl builds of some native
# tooling crash on it (see the funcia / visit-counter pipelines).

FROM node:24-bookworm-slim AS deps
WORKDIR /app
ENV CI=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run typecheck && npm run build

FROM build AS test
RUN npm run lint && npm run format:check && npm test

FROM deps AS prod-deps
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ARG APP_VERSION=dev
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    APP_VERSION=${APP_VERSION}
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/server/index.js"]
