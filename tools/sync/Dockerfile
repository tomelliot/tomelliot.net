# The gallery sync: reads an Immich tag, publishes derivatives, pushes the site.
# Nothing is installed from npm — the tool runs on Node's standard library plus
# ImageMagick and git.
FROM node:22-alpine

# Alpine splits ImageMagick's delegates into packages: imagemagick-jpeg reads the
# originals, imagemagick-heic is the libheif delegate; Alpine's libheif ships AVIF *decoders*
# only, so libheif-aom supplies the encoder. Verified on Alpine 3.24 / IM 7.1.2.
RUN apk add --no-cache imagemagick imagemagick-jpeg imagemagick-webp imagemagick-heic libheif-aom \
        git openssh-client ca-certificates \
    && adduser -D -u 1001 gallery

WORKDIR /app
ENV REPO_DIR=/data/site \
    NODE_ENV=production

COPY server.mjs immich-workflow.mjs /app/

# The site repo is cloned into a volume on first run, so the image carries no
# credentials and can be rebuilt without losing published state.
# The user is `gallery` because Alpine ships a built-in `sync` user (uid 5).
RUN mkdir -p /data && chown -R gallery:gallery /data /app
USER gallery

EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:8080/healthz > /dev/null || exit 1

CMD ["node", "/app/server.mjs"]
