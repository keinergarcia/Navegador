#!/usr/bin/env bash
# =============================================================================
# CloudDesk - instala Docker Engine + Compose v2 en Ubuntu/Debian ARM64.
#
# Uso:  sudo ./scripts/install-docker.sh
#
# Repositorio oficial de Docker (no el paquete docker.io de Ubuntu, que no
# incluye el plugin compose v2 actualizado). Compatible con arm64.
# =============================================================================
source "$(dirname "$0")/lib.sh"

require_root "$@"
require_cmd apt-get curl gpg

if [[ ! -r /etc/os-release ]]; then
  die "no se pudo leer /etc/os-release."
fi
# shellcheck disable=SC1091
. /etc/os-release

case "${ID:-}" in
  ubuntu|debian) ;;
  *) die "distribución no soportada: ${ID:-desconocida}. Este script es para Ubuntu/Debian." ;;
esac

ARCH="$(dpkg --print-architecture)"
case "$ARCH" in
  arm64|amd64) ;;
  *) die "arquitectura $ARCH no soportada por este script." ;;
esac

if [[ -z "${VERSION_CODENAME:-}" ]]; then
  die "VERSION_CODENAME no definido en /etc/os-release."
fi

log "instalando Docker en $PRETTY_NAME ($ARCH)"
step 'eliminando paquetes en conflicto (si existen)'
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
  apt-get remove -y "$pkg" >/dev/null 2>&1 || true
done

step 'instalando dependencias'
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ca-certificates curl gnupg openssl >/dev/null

step 'añadiendo la clave y el repositorio oficial de Docker'
install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable
EOF

step 'instalando docker-ce, buildx y compose v2'
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null

systemctl enable --now docker

TARGET_USER="${SUDO_USER:-}"
if [[ -z "$TARGET_USER" || "$TARGET_USER" == "root" ]]; then
  warn "no se pudo detectar un usuario no root; añade uno manualmente: sudo usermod -aG docker <usuario>"
else
  if id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx docker; then
    ok "$TARGET_USER ya pertenece al grupo docker"
  else
    usermod -aG docker "$TARGET_USER"
    ok "$TARGET_USER añadido al grupo docker"
  fi
fi

printf '\n'
docker --version
docker compose version
printf '\n'
ok 'Docker instalado.'
printf '%s\n' "Cierra la sesión SSH y vuelve a entrar (o ejecuta 'newgrp docker') para usar docker sin sudo."
printf '%s\n' "Comprueba con: docker run --rm hello-world"
