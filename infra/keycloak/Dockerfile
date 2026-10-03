FROM quay.io/keycloak/keycloak:26.8.0 AS builder
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_FEATURES=resource-indicators
RUN /opt/keycloak/bin/kc.sh build
FROM quay.io/keycloak/keycloak:26.8.0
COPY --from=builder /opt/keycloak/ /opt/keycloak/
COPY --chmod=0555 infra/keycloak/start.sh /opt/keycloak/bin/playdot-start.sh
USER 1000:0
ENTRYPOINT ["/bin/bash", "/opt/keycloak/bin/playdot-start.sh"]
