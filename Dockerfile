# Console agences. Node 24 runs the TypeScript sources directly: no build step.
# The image also carries the tools the operations shell out to:
#   pg_dump / pg_restore (backups, restores, drills), docker CLI (migrate image), mc (MinIO scoped keys).
FROM node:24-alpine

# minio-client comes from Alpine (installed as mcli): dl.min.io stopped serving the mc binary (HTTP 410).
RUN apk add --no-cache postgresql17-client docker-cli ca-certificates wget minio-client \
 && ln -s /usr/bin/mcli /usr/local/bin/mc

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY migrations ./migrations
COPY public ./public

# Runs as root on purpose: the Docker socket and the proxy's dynamic directory are mounted
# from the host (see README, "Deploy"), and both belong to root there.
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3100}/health" > /dev/null || exit 1

CMD ["node", "src/index.ts"]
