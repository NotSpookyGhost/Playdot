ARG POSTGRES_IMAGE=postgres:17.11-bookworm
FROM ${POSTGRES_IMAGE}
COPY --chmod=0555 infra/postgres/10-playdot.sh /docker-entrypoint-initdb.d/10-playdot.sh
