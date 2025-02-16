# syntax=docker/dockerfile:1.4
# central place to configure the production replayweb.page loading prefix
ARG RWP_BASE_URL=https://cdn.jsdelivr.net/npm/replaywebpage/

FROM docker.io/library/node:16 as build_deps

WORKDIR /app
COPY yarn.lock package.json ./
# Uses `yarn cache clean` to let Docker cache layer instead
# of including yarn cache in the build image
RUN yarn --production --frozen-lockfile --network-timeout 1000000 && \
    yarn cache clean

FROM build_deps as build

COPY --link lit-localize.json \
    postcss.config.js \
    tailwind.config.js \
    tsconfig.json \
    webpack.config.js \
    webpack.prod.js \
    index.d.ts \
    ./

COPY --link src ./src/

# Build variables used to show current app version
# in the UI. Note that this will invalidate all
# subsequent RUN steps.
ARG GIT_COMMIT_HASH
ARG GIT_BRANCH_NAME
ARG VERSION

ENV GIT_COMMIT_HASH=${GIT_COMMIT_HASH} \
    GIT_BRANCH_NAME=${GIT_BRANCH_NAME} \
    VERSION=${VERSION}

# Prevent Docker caching node_modules
RUN yarn build && \
    rm -rf ./node_modules

FROM docker.io/library/nginx:1.23.2

ARG RWP_BASE_URL
ENV RWP_BASE_URL=${RWP_BASE_URL}

COPY --link --from=build /app/dist /usr/share/nginx/html

#COPY ./nginx.conf /etc/nginx/nginx.conf
COPY --link ./frontend.conf.template /etc/nginx/templates/
COPY --link ./minio.conf /etc/nginx/includes/

ADD --link ./00-browsertrix-nginx-init.sh ./docker-entrypoint.d/

