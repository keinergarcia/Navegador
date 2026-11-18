#!/usr/bin/env bash
# =============================================================================
# CloudDesk - arranque automático en GitHub Codespaces.
#
# Lo invoca el devcontainer en cada inicio (postStartCommand). Espera a que
# Docker-in-Docker esté listo, construye la imagen si hace falta y arranca el
# escritorio. Es idempotente y escribe el registro en /tmp/clouddesk-boot.log.
#
# No bloquea el arranque del Codespace: se lanza en segundo plano.
# =============================================================================
set -Eeuo pipefail

LOG=/tmp/clouddesk-boot.log
exec >>"$LOG" 2>&1
echo "=== clouddesk boot $(date -Is) ==="

# Evita dos arranques simultáneos (postCreate + postStart).
exec 9>/tmp/clouddesk-boot.lock
if ! flock -n 9; then
  echo "ya hay un arranque en curso; salgo"
  exit 0
fi

cd "$(dirname "$0")/.."

if [[ -z "${VNC_PASSWORD:-}" ]]; then
  echo "aviso: VNC_PASSWORD no está definido; se generará uno y se guardará en tests/.artifacts/"
else
  echo "usando VNC_PASSWORD del secreto de Codespaces"
fi

echo "esperando a Docker-in-Docker..."
for _ in $(seq 1 120); do
  if docker info >/dev/null 2>&1; then break; fi
  sleep 5
done
if ! docker info >/dev/null 2>&1; then
  echo "error: Docker no está disponible tras 10 minutos"
  exit 1
fi

if docker image inspect clouddesk/desktop:codespaces >/dev/null 2>&1; then
  echo "imagen presente; arrancando sin reconstruir"
  ./scripts/codespaces-up.sh --no-build --if-needed
else
  echo "construyendo la imagen del escritorio (puede tardar 10-20 min)"
  ./scripts/codespaces-up.sh --if-needed
fi

echo "=== clouddesk boot ok $(date -Is) ==="
