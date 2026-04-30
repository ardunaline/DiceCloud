FROM node:14-buster AS builder

RUN curl -sL https://install.meteor.com/ | sed 's/^RELEASE=.*/RELEASE="2.16"/' | sh

WORKDIR /app
COPY .meteor .meteor
COPY package.json package-lock.json ./

# Meteor will install npm deps during build, but pre-installing helps caching
RUN meteor npm install

COPY . .
RUN meteor build --directory /app/bundle --server-only

FROM node:14-buster-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/bundle/bundle .

RUN cd programs/server && npm install --production && npm prune --production

ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "main.js"]
