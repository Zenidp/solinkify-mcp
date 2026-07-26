# Solinkify MCP server — stdio transport.
#
#   docker build -t solinkify-mcp .
#   docker run -i --rm solinkify-mcp                 # starts, lists tools, no wallet needed
#   docker run -i --rm -v $PWD/agent.json:/wallet.json:ro \
#     -e SOLINKIFY_WALLET_PATH=/wallet.json solinkify-mcp    # able to pay
#
# stdin/stdout carry the MCP protocol, so `-i` is required and nothing may be
# printed to stdout (the server reroutes its logs to stderr).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY README.md server.json ./
USER node
ENTRYPOINT ["node", "dist/cli.js"]
