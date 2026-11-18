#!/usr/bin/env bash
# =============================================================================
# CloudDesk - actualiza el sistema y el stack.
#
# Uso:
#   ./scripts/update.sh              # reconstruye imágenes y recrea servicios
#   ./scripts/update.sh --with-apt   # además: apt update && apt upgrade
#   ./scripts/update.sh --no-smoke   # sin prueba de humo final
#
# No actualiza la versión de KasmVNC: está fijada en desktop/Dockerfile
# (KASMVNC_VERSION). Para subirla, cambia el ARG y la suma SHA-256.
# =============================================================================
source "$(dirname "$0")/lib.sh"

WITH_APT=0
SMOKE=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-apt) WITH_APT=1; shift ;;
    --no-smoke) SMOKE=0; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "opción desconocida: $1" ;;
  esac
done

require_cmd docker
load_env
require_docker

if [[ "$WITH_APT" -eq 1 ]]; then
  require_root "$@"
  log 'actualizando paquetes del sistema'
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq
  ok 'sistema actualizado'
fi

if [[ -d "$ROOT_DIR/.git" ]]; then
  if [[ "${CLOUDDESK_SKIP_PULL:-0}" -eq 1 ]]; then
    warn 'git pull omitido (CLOUDDESK_SKIP_PULL=1).'
  elif [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
    warn 'hay cambios locales sin commitear: no se hace git pull.'
  elif [[ -z "$(git -C "$ROOT_DIR" symbolic-ref -q HEAD || true)" ]]; then
    # Despliegue por tag o commit concreto: el checkout ya lo hizo el CI.
    warn 'HEAD separado (tag/commit): no se hace git pull.'
  else
    log 'actualizando el código desde git'
    git -C "$ROOT_DIR" pull --ff-only
  fi
fi

log 'reconstruyendo imágenes (con --pull)'
compose build --pull

log 'recreando servicios'
compose up -d --remove-orphans

log 'limpiando imágenes huérfanas'
docker image prune -f >/dev/null || true

ok 'stack actualizado'
compose ps

if [[ "$SMOKE" -eq 1 ]]; then
  printf '\n'
  log 'prueba de humo (sin sesión)'
  "$ROOT_DIR/scripts/smoke-test.sh" || warn 'la prueba de humo encontró fallos; revisa los registros.'
fi

printf '\n%s\n' "Registros: docker compose logs -f --tail=100"
