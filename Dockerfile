FROM node:22-alpine

RUN corepack enable

WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile --prod

COPY src ./src

ENV NODE_ENV=production
USER node

# Railway injects PORT; 3001 is the local default.
EXPOSE 3001

CMD [ "node", "src/server/index.js" ]
