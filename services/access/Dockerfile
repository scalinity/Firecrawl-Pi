# FCPI access gateway (FIRECRAWL_PI_SPEC.md §16, §20.3). node:22.23.3-bookworm-slim, linux/arm64 by digest
# (the image the gateway ran as a bind mount in M1 and M2); pg from package-lock.json with integrity
# checks, install scripts off. The deployed commit is recorded in the image, so every log line names
# the source it runs. Runs as uid 3380.
FROM node:22.23.3-bookworm-slim@sha256:a0ddbc73510e98f5e824fd64266ffe1c2c343ba9cf260d95ca2985ad632a3f3e
ARG FCPI_SOURCE_COMMIT=unknown
ENV FCPI_SOURCE_COMMIT=${FCPI_SOURCE_COMMIT}
WORKDIR /srv/access
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force && node --version && npm ls --omit=dev --all
COPY server.mjs ./
COPY src ./src
USER 3380:3380
CMD ["node", "server.mjs"]
