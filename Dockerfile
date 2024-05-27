FROM node:22-slim

WORKDIR /app

COPY package.json yarn.lock ./
COPY src src

RUN --mount=type=cache,target=/root/.yarn YARN_CACHE_FOLDER=/root/.yarn yarn --frozen-lockfile --production

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
