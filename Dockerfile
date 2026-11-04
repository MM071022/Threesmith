# Threesmith MCP server in a container, built from this repository.
# Used by MCP directories such as Glama to build and test the server; for your own use, `npx -y threesmith mcp` is simpler.
#
#   docker build -t threesmith .
#   docker run -i --rm -v "$PWD:/project" -e THREESMITH_PROJECT=/project threesmith
#
# The project mounted at /project must have three in node_modules for the API lookup and the review. The browser
# check (three_check) needs playwright-core and Chromium, which this image does not hold; the rest works without them.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY data ./data
COPY PRIVACY.md LICENSE ./
USER node
ENTRYPOINT ["node", "dist/cli.js", "mcp"]
