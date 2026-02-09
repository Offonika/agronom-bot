FROM node:20
WORKDIR /usr/src/app

# Ensure modules installed here are visible to shared code in /usr/src
ENV NODE_PATH=/usr/src/app/node_modules

# Run as non-root in production.
RUN mkdir -p /usr/src/services && chown -R node:node /usr/src/app /usr/src/services
USER node

# Install dependencies using bot package manifests
COPY --chown=node:node bot/package*.json ./
RUN npm ci

# Copy bot sources
COPY --chown=node:node bot/ .
# Include shared localization files
COPY --chown=node:node locales ./locales
# Include shared JS services used by the bot (keep path consistent with ../services import)
COPY --chown=node:node services /usr/src/services

ENTRYPOINT ["node", "index.js"]
