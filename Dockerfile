FROM node:14-buster AS builder

RUN curl https://install.meteor.com/ | sed 's/^RELEASE=.*/RELEASE="2.16"/' | sh

WORKDIR /app
COPY app/.meteor app/.meteor
COPY app/package.json app/package-lock.json ./
RUN meteor npm install

COPY app/ .
RUN meteor build --directory /bundle --server-only

FROM node:14-buster-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /bundle/bundle .
RUN cd programs/server && npm install --production && npm prune --production \
  && apt-get purge -y python3 make g++ \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "main.js"]
