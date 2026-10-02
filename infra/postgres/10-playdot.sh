#!/bin/sh
set -eu
# New clusters only; never prints passwords or passes them in command arguments.
export PLAYDOT_APP_PASSWORD="$(cat /run/secrets/app_db_password)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password PLAYDOT_APP_PASSWORD
CREATE ROLE playdot LOGIN PASSWORD :'app_password';
GRANT CONNECT, CREATE ON DATABASE :"DBNAME" TO playdot;
ALTER SCHEMA public OWNER TO playdot;
SQL
unset PLAYDOT_APP_PASSWORD
