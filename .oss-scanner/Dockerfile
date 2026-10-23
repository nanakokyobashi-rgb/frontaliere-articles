FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    CI=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Keep only HEAD and refs in the build context, then fetch that exact commit
# shallowly instead of transferring the repository's full Git object store.
COPY .git/ /tmp/frontaliere-articles-git/
RUN set -eu; \
    head="$(cat /tmp/frontaliere-articles-git/HEAD)"; \
    case "$head" in \
      "ref: "*) \
        ref="${head#ref: }"; \
        if [ -f "/tmp/frontaliere-articles-git/$ref" ]; then \
          commit="$(cat "/tmp/frontaliere-articles-git/$ref")"; \
        else \
          commit="$(awk -v ref="$ref" '$2 == ref { print $1; exit }' /tmp/frontaliere-articles-git/packed-refs 2>/dev/null || true)"; \
        fi \
        ;; \
      *) commit="$head" ;; \
    esac; \
    case "$commit" in \
      ''|*[!0-9a-f]*) echo 'Could not resolve the articles checkout commit' >&2; exit 1 ;; \
    esac; \
    [ "${#commit}" -eq 40 ] || [ "${#commit}" -eq 64 ]; \
    git init --quiet /src; \
    git -C /src remote add origin https://github.com/nanakokyobashi-rgb/frontaliere-articles.git; \
    git -C /src fetch --quiet --no-tags --depth=1 origin "$commit"; \
    git -C /src checkout --quiet --detach FETCH_HEAD; \
    test "$(git -C /src rev-parse HEAD)" = "$commit"; \
    rm -rf /tmp/frontaliere-articles-git

RUN npm ci --no-audit --no-fund
RUN npm install --global --no-audit --no-fund tsx@4.23.15
RUN npm install --no-save --no-package-lock --no-audit --no-fund typescript@5.8.3
ENV ARTICLE_SOURCE_TYPESCRIPT=/src/node_modules/typescript/lib/typescript.js
RUN tsx scripts/build-api.mjs
