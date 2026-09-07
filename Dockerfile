FROM public.ecr.aws/docker/library/node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json jest.config.js ./
COPY src ./src
COPY ui ./ui
COPY tests ./tests
COPY scripts ./scripts
COPY eval ./eval
RUN npm run typecheck && npm run test:unit && npm run test:history && npm run test:auth && npm run ui:build
RUN npm prune --omit=dev

FROM public.ecr.aws/docker/library/node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/ui/dist ./ui/dist
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DATA_DIR=/data
EXPOSE 3001
CMD ["node", "--import", "tsx", "src/server/index.ts"]
