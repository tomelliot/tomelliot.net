# The gallery sync: reads an Immich tag, publishes derivatives, pushes the site.
# Nothing is installed from npm — the tool runs on Node's standard library plus
# ImageMagick and git.
FROM node:22-alpine

# imagemagick-heic carries the libheif delegate ImageMagick needs to write AVIF.
RUN apk add --no-cache imagemagick imagemagick-heic git openssh-client ca-certificates \
    && adduser -D -u 1001 sync

WORKDIR /app
ENV REPO_DIR=/data/site \
    NODE_ENV=production

COPY server.mjs immich-workflow.mjs /app/

# The site repo is cloned into a volume on first run, so the image carries no
# credentials and can be rebuilt without losing published state.
RUN mkdir -p /data && chown -R sync:sync /data /app
USER sync

EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:8080/healthz > /dev/null || exit 1

CMD ["node", "/app/server.mjs"]
