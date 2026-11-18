# syntax=docker/dockerfile:1
#
# CloudDesk - contenedor del escritorio Linux
# Base: Debian 13 "trixie" (arm64/amd64). Debian incluye Chromium nativo
# (Ubuntu lo empaqueta como snap, inutilizable dentro de un contenedor).
#
FROM debian:13-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG KASMVNC_VERSION=1.5.2
ARG KASMVNC_SHA256_ARM64=904615b506c517242f3da3ff2eacd349013fc8cdb2dc205e5e4dad4ec6f62fa9
# Verificado el 2026-11-18 descargando el .deb oficial de v1.5.2 y calculando
# sha256sum. El método se validó comprobando que el hash ARM64 calculado con el
# mismo procedimiento coincide con el valor ya fijado arriba.
ARG KASMVNC_SHA256_AMD64=6ed957163275088a5ce52b525f82f145014e3289699d576ce26745a4249407f8
ARG TARGETARCH

LABEL org.opencontainers.image.title="CloudDesk desktop" \
      org.opencontainers.image.description="XFCE + Chromium servido por KasmVNC" \
      org.opencontainers.image.licenses="MIT"

# ---------------------------------------------------------------------------
# Paquetes del sistema
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      xfce4 \
      xfce4-terminal \
      xfce4-taskmanager \
      thunar \
      dbus-x11 \
      chromium \
      supervisor \
      python3-minimal \
      fonts-dejavu-core \
      fonts-liberation \
      fonts-noto-color-emoji \
      xdg-utils \
      x11-utils \
      x11-xserver-utils \
      xauth \
      procps \
      net-tools \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f >/dev/null

# ---------------------------------------------------------------------------
# KasmVNC (servidor VNC con cliente web propio; obligatorio en ARM64)
# Se descarga el .deb oficial y se verifica su SHA-256 antes de instalar.
# ---------------------------------------------------------------------------
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      arm64) expected="$KASMVNC_SHA256_ARM64" ;; \
      amd64) expected="$KASMVNC_SHA256_AMD64" ;; \
      *) echo "Arquitectura no soportada: $arch" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_debian_trixie_${KASMVNC_VERSION}_${arch}.deb"; \
    curl -fsSL --retry 3 -o /tmp/kasmvnc.deb "$url"; \
    if [ -n "$expected" ]; then \
      echo "${expected}  /tmp/kasmvnc.deb" | sha256sum -c -; \
    else \
      echo "AVISO: sin SHA-256 fijado para $arch (build de desarrollo)"; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends /tmp/kasmvnc.deb; \
    rm -f /tmp/kasmvnc.deb; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Usuario sin privilegios
# ---------------------------------------------------------------------------
RUN set -eux; \
    if getent group 1000 >/dev/null; then groupadd desk; else groupadd -g 1000 desk; fi; \
    if getent passwd 1000 >/dev/null; then \
      useradd -m -d /home/desk -g desk -s /bin/bash desk; \
    else \
      useradd -m -u 1000 -d /home/desk -g desk -s /bin/bash desk; \
    fi; \
    mkdir -p /home/desk/.vnc /home/desk/.clouddesk /var/log/clouddesk; \
    chown -R desk:desk /home/desk /var/log/clouddesk

# ---------------------------------------------------------------------------
# Configuración propia
# ---------------------------------------------------------------------------
COPY rootfs/ /
COPY home/ /home/desk/

RUN set -eux; \
    chmod 0755 /opt/clouddesk/*.sh /opt/clouddesk/entrypoint.sh; \
    chmod 0644 /opt/clouddesk/*.py /opt/clouddesk/*.tmpl; \
    chmod 0644 /home/desk/.config/autostart/*.desktop; \
    chown -R desk:desk /home/desk; \
    # El cliente KasmVNC se sirve desde su propio directorio; no tocamos www.
    true

USER root
WORKDIR /home/desk
EXPOSE 8444 8099
ENTRYPOINT ["/opt/clouddesk/entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf", "-n"]
