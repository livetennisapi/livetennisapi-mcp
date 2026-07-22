# Container image for the Live Tennis API MCP server (stdio transport).
#
# Exists so automated indexers (Glama and friends) can start the server and run
# an introspection handshake without credentials. That works because the no-key
# path is deliberately non-fatal: with LIVETENNISAPI_KEY unset the server still
# completes initialize + tools/list and every tool returns a plain-text
# explanation naming the env var, rather than erroring. See test/protocol.mjs.
#
# Build:  docker build -t livetennisapi-mcp .
# Run:    docker run --rm -i -e LIVETENNISAPI_KEY=twjp_... livetennisapi-mcp
#
# stdio means the container needs `-i`; there is no port to publish.

# --- build ---------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install with the lockfile first so the dep layer caches independently of src.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# Drop dev dependencies — tsup/typescript are not needed at runtime.
RUN npm ci --omit=dev

# --- runtime -------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Run unprivileged. `node` (uid 1000) ships with the base image.
USER node

ENTRYPOINT ["node", "dist/index.js"]
