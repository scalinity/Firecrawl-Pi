# FCPI MCP gateway (FIRECRAWL_PI_SPEC.md §17). node:22.23.3-bookworm-slim, linux/arm64 by digest (the
# access gateway's base); the SDK packages from package-lock.json with integrity checks, install scripts
# off, dev dependencies (the test client) left out. The deployed commit is recorded in the image, so
# every log line names the source it runs. Runs as uid 3400.
FROM node:22.23.3-bookworm-slim@sha256:a0ddbc73510e98f5e824fd64266ffe1c2c343ba9cf260d95ca2985ad632a3f3e
ARG FCPI_SOURCE_COMMIT=unknown
ENV FCPI_SOURCE_COMMIT=${FCPI_SOURCE_COMMIT}
WORKDIR /srv/mcp
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force && node --version && npm ls --omit=dev --all
COPY server.mjs ./
COPY src ./src
USER 3400:3400
CMD ["node", "server.mjs"]
