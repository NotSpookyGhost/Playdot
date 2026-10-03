#!/bin/bash
set -eu
# No shell tracing, command-line password or secret embedded in the image.
export KC_DB_PASSWORD="$(</run/secrets/identity_app_password)"
export KC_BOOTSTRAP_ADMIN_PASSWORD="$(</run/secrets/identity_admin_password)"
exec /opt/keycloak/bin/kc.sh start --optimized --import-realm
