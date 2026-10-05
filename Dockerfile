# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN npm install --global pnpm@10.33.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM debian:bookworm-slim AS scrcpy
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fLsS --retry 3 https://github.com/Genymobile/scrcpy/releases/download/v4.1/scrcpy-linux-x86_64-v4.1.tar.gz -o /tmp/scrcpy.tar.gz \
    && echo 'ad56ae8bfeedf41e824945c11dbf55fcb092b3e615b9b486f48a50e30d389635  /tmp/scrcpy.tar.gz' | sha256sum -c - \
    && mkdir /opt/scrcpy && tar -xzf /tmp/scrcpy.tar.gz --strip-components=1 -C /opt/scrcpy

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl tini libusb-1.0-0 libudev1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=scrcpy /opt/scrcpy /opt/scrcpy
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 HTTPS=true TLS_DIR=/home/node/.tls \
    ADB_PATH=/opt/scrcpy/adb SCRCPY_SERVER_PATH=/opt/scrcpy/scrcpy-server \
    PATH="/opt/scrcpy:${PATH}"
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY docker/healthcheck.mjs ./docker/healthcheck.mjs
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/studio-entrypoint
RUN mkdir -p /home/node/.android /home/node/.tls && chown node:node /home/node/.android /home/node/.tls
USER node
VOLUME ["/home/node/.android", "/home/node/.tls"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "docker/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/studio-entrypoint"]
CMD ["node", "server/index.mjs"]
