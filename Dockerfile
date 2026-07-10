# ── SUSE BCI — Base Container Image ─────────────────────────────────────────
# registry.suse.com/bci/nodejs:20
#
# SUSE BCI (Base Container Images) are the same trusted, enterprise-grade
# foundation as SUSE Linux Micro — FIPS-ready, OCI-compliant, continuously
# updated, and fully supported by SUSE.
#
# Multi-arch: both linux/amd64 and linux/arm64 are published, so the same
# image tag runs on x86 and ARM nodes without changes.
#
# BCI docs: https://registry.suse.com  ·  https://opensource.suse.com/bci
# ─────────────────────────────────────────────────────────────────────────────
FROM registry.suse.com/bci/nodejs:20

LABEL org.opencontainers.image.title="vertex-bank-app"
LABEL org.opencontainers.image.description="Vertex Trust Bank — Platform Operations Console (SUSE Virtualization demo)"
LABEL org.opencontainers.image.source="https://github.com/SUSE-Technical-Marketing/vertex-bank-app"
LABEL org.opencontainers.image.vendor="SUSE Technical Marketing"
LABEL org.opencontainers.image.base.name="registry.suse.com/bci/nodejs:20"

WORKDIR /app

# Create the non-root user and group with explicit UID/GID 1000 so it matches
# the runAsUser: 1000 in the Deployment securityContext. Without --uid/--gid,
# useradd --system picks a UID in the 100-999 range which does NOT match what
# Kubernetes injects, causing EACCES at runtime.
RUN groupadd --gid 1000 vbank && \
    useradd  --uid 1000 --gid vbank --no-create-home --shell /sbin/nologin vbank

# COPY + chown in one RUN avoids a separate layer with wrong ownership.
COPY app/server.js  /app/server.js
COPY app/index.html /app/index.html

RUN chown -R vbank:vbank /app && \
    chmod 755 /app/server.js && \
    chmod 644 /app/index.html

USER vbank

EXPOSE 3000

ENV PORT=3000 \
    NODE_ENV=production

# BCI includes curl — use it for the healthcheck.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3000/health || exit 1

CMD ["node", "/app/server.js"]
