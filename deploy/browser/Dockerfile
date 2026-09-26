# FCPI browser worker (spec §12; decisions D1 and D2 in evidence/M0/review/DECISIONS.md).
# Base: Playwright 1.63.0's Ubuntu 24.04 image, linux/arm64 manifest by digest, carrying Chromium
# 153.0.8010.12 (browsers.json revision 1243) from Google's Chrome for Testing linux-arm64 build.
# D1 admission, the archive hashes and the native proof: evidence/M2/INTERPRETATION.md.
# playwright-core is the same 1.63.0, from package-lock.json with its integrity checked; install
# scripts are off, so no browser is downloaded here. Runs as uid 3320 under deploy/browser/seccomp.json.
# Build context: services/browser (scripts/m2/pi-build-service-images.sh builds it on the Pi, which holds
# the base image already).
FROM mcr.microsoft.com/playwright@sha256:a0f4498920a5dbac63196d9140ed738ef00470f27e2e74029abd8850b7bd5717
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /srv/browser
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force && node --version && npm ls --omit=dev --all
COPY src ./src
USER 3320:3320
CMD ["node", "src/server.mjs"]
