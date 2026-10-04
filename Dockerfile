# Strata — single image: API (serves the web client), local vision engine, field adapters and the synthetic
# simulator. CPU only; no external services at run time.
#
#   docker build -t strata .                              # fetches the vision models during the build
#   docker build --build-arg FETCH_MODELS=false -t strata .   # air-gapped: mount models at run time instead
#     docker run -v /srv/strata-models:/models:ro -e STRATA_MODELS_DIR=/models …
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/domain/package.json packages/domain/
COPY packages/simulator/package.json packages/simulator/
COPY packages/adapters/package.json packages/adapters/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
# Vision models (pinned by SHA-256 in models/manifest.json; verified here and again at load).
ARG FETCH_MODELS=true
RUN if [ "$FETCH_MODELS" = "true" ]; then node scripts/fetch-models.mjs; fi

FROM node:22-bookworm-slim
# ffmpeg: video evidence, frame extraction and network cameras (RTSP/HTTP).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000 DATA_DIR=/data SIM_STATE_FILE=/data/sim-state.json STRATA_IMPORT_DIR=/data/import
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/models ./models
COPY --from=build /app/apps/server/package.json ./apps/server/
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/simulator/dist ./packages/simulator/dist
COPY --from=build /app/packages/adapters/dist ./packages/adapters/dist
COPY --from=build /app/packages/adapters/adapters.example.json ./packages/adapters/
RUN groupadd -r strata && useradd -r -g strata strata && mkdir -p /data/import && chown -R strata:strata /data
USER strata
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/start.mjs"]
