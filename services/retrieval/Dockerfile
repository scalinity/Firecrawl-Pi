# FCPI retrieval service (FIRECRAWL_PI_SPEC.md §8.3). node:22.23.3-bookworm-slim, linux/arm64 by digest
# (the image the access gateway runs); dependencies from package-lock.json with integrity checks,
# install scripts off. The deployed commit is recorded in the image (M5). Runs as uid 3310.
FROM node:22.23.3-bookworm-slim@sha256:a0ddbc73510e98f5e824fd64266ffe1c2c343ba9cf260d95ca2985ad632a3f3e
ARG FCPI_SOURCE_COMMIT=unknown
ENV FCPI_SOURCE_COMMIT=${FCPI_SOURCE_COMMIT}
WORKDIR /srv/retrieval
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force && node --version && npm ls --omit=dev --all
COPY src ./src
USER 3310:3310
CMD ["node", "src/server.mjs"]
