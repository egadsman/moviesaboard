# MoviesAboard station image: node + ffmpeg (demo fixture encoding),
# tzdata (station timezone math), openssl (self-signed TLS). The
# container runs scripts/docker-entry.js, which boots the station against
# the /data volume and listens on :4321 (internal only — nginx in the
# `web` service fronts it; see docker-compose.yml).

FROM node:22-alpine

RUN apk add --no-cache ffmpeg tzdata openssl

WORKDIR /app

# Package manifests first so the npm ci layer survives source-only
# changes (the workspace manifest must be present for the lockfile).
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
RUN npm ci

# The rest of the repo (.dockerignore keeps node_modules, demo-dist,
# station-data and .git out of the context).
COPY . .

ENV NODE_ENV=production
EXPOSE 4321
CMD ["node", "scripts/docker-entry.js"]
