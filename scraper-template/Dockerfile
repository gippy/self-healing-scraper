FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# pnpm comes from package.json's packageManager field through corepack.
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY . .

EXPOSE 8080
CMD ["pnpm", "start"]
