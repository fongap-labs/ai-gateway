# Container image for running ai-gateway on a cloud host with Docker.
# The image runs the same fetch handler as the Cloudflare Worker through docker/server.mjs.
# Runtime requirements: Node.js >= 22.18.0 (type stripping loads src/*.ts directly).
# Runtime has no npm dependencies, so no install step is needed.

FROM node:22.22.0-bookworm-slim

ARG AIG_BUILD_SHA=unknown
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    AIG_BUILD_SHA=${AIG_BUILD_SHA}

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node docker ./docker

USER node

EXPOSE 8787

# Healthy when the process answers HTTP below 500. /health itself needs a group key,
# so an unauthenticated 401 still counts as reachable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then((r) => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "docker/server.mjs"]
