ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app

RUN npm install --global pnpm@9.12.1
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY nuxt.config.ts tsconfig.json ./
COPY app ./app
COPY server ./server
COPY shared ./shared
RUN NITRO_PRESET=node-server pnpm build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4310 \
    NUXT_DATA_DIR=/app/data \
    TZ=Asia/Shanghai

COPY --from=build /app/.output ./.output
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
USER node

EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:4310/api/health').then(async r => { if (!r.ok || !(await r.json()).data.ok) process.exit(1) }).catch(() => process.exit(1))"]
CMD ["node", ".output/server/index.mjs"]
