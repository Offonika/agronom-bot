FROM node:20
WORKDIR /usr/src/app

ENV NODE_PATH=/usr/src/app/node_modules

# Run as non-root in production.
RUN chown -R node:node /usr/src/app
USER node

COPY --chown=node:node package*.json ./
# Production image: do not ship devDependencies (spectral/ts-node/etc).
RUN npm ci --omit=dev

COPY --chown=node:node worker ./worker
COPY --chown=node:node services ./services
COPY --chown=node:node locales ./locales

ENTRYPOINT ["node", "worker/autoplan.js"]
