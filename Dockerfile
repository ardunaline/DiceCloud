FROM node:14-buster AS builder

# Buster is EOL — repos moved to archive.debian.org
RUN sed -i 's|http://deb.debian.org/debian|http://archive.debian.org/debian|g' /etc/apt/sources.list && \
    sed -i 's|http://security.debian.org/debian-security|http://archive.debian.org/debian-security|g' /etc/apt/sources.list && \
    sed -i '/buster-updates/d' /etc/apt/sources.list && \
    apt-get update

RUN curl https://install.meteor.com/ | sed 's/^RELEASE=.*/RELEASE="2.16"/' | sh

WORKDIR /app
COPY app/.meteor app/.meteor
COPY app/package.json app/package-lock.json ./
RUN meteor npm install

ENV METEOR_ALLOW_SUPERUSER=true

COPY app/ .
RUN meteor build --directory /bundle --server-only

FROM node:14-buster-slim

# Buster is EOL — repos moved to archive.debian.org
RUN sed -i 's|http://deb.debian.org/debian|http://archive.debian.org/debian|g' /etc/apt/sources.list && \
    sed -i 's|http://security.debian.org/debian-security|http://archive.debian.org/debian-security|g' /etc/apt/sources.list && \
    sed -i '/buster-updates/d' /etc/apt/sources.list

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
