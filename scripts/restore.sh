#!/usr/bin/env bash
# =============================================================================
# CloudDesk - restaura una copia creada por backup.sh.
#
# Uso:
#   ./scripts/restore.sh backups/clouddesk-20260101-030000.tar.gz [--yes] [--no-start]
#
# ATENCIÓN: reemplaza .env, data/letsencrypt y TODO el contenido del volumen
# del escritorio. El stack se detiene antes de restaurar.
# =============================================================================
source "$(dirname "$0")/lib.sh"

ARCHIVE="${1:-}"
[[ -n "$ARCHIVE" ]] || die "uso: $0 <archivo.tar.gz> [--yes] [--no-start]"
shift || true
ASSUME_YES=0
START=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) ASSUME_YES=1; shift ;;
    --no-start) START=0; shift ;;
    *) die "opción desconocida: $1" ;;
  esac
done

[[ -f "$ARCHIVE" ]] || die "no existe $ARCHIVE"
ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"
require_cmd docker tar sha256sum
require_docker

if [[ -f "$ARCHIVE.sha256" ]]; then
  step 'verificando el checksum'
  (cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256") \
    || die 'el checksum no coincide: archivo corrupto o manipulado.'
fi

DESKTOP_IMAGE="${DESKTOP_IMAGE:-clouddesk/desktop:1.5.2}"
VOLUME_NAME="${VOLUME_NAME:-clouddesk_desktop_home}"
docker image inspect "$DESKTOP_IMAGE" >/dev/null 2>&1 \
  || die "no existe la imagen $DESKTOP_IMAGE. Construye el stack antes de restaurar."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
step 'extrayendo el archivo'
tar -xzf "$ARCHIVE" -C "$TMP"
[[ -f "$TMP/.env" && -f "$TMP/home.tar.gz" ]] || die 'el archivo no tiene el formato esperado (.env + home.tar.gz).'

printf '\n%s\n' "${C_BOLD}Contenido a restaurar:${C_RESET}"
tar -tzf "$ARCHIVE" | sed -n '1,15p' | sed 's/^/  /'
printf '\n%s\n' "${C_YELLOW}Se sobrescribirán .env, los certificados y el volumen $VOLUME_NAME.${C_RESET}"
if [[ "$ASSUME_YES" -ne 1 ]]; then
  if ! confirm '¿Continuar con la restauración?' n; then
    die 'cancelado.'
  fi
fi

log 'deteniendo el stack'
compose down

STAMP="$(date +%Y%m%d-%H%M%S)"
[[ -f "$ROOT_DIR/.env" ]] && cp "$ROOT_DIR/.env" "$ROOT_DIR/.env.bak-restore-$STAMP"
if [[ -d "$ROOT_DIR/data/letsencrypt" ]]; then
  mv "$ROOT_DIR/data/letsencrypt" "$ROOT_DIR/data/letsencrypt.bak-$STAMP"
fi

step 'restaurando .env y certificados'
cp "$TMP/.env" "$ROOT_DIR/.env"
chmod 600 "$ROOT_DIR/.env"
mkdir -p "$ROOT_DIR/data"
cp -a "$TMP/data/letsencrypt" "$ROOT_DIR/data/letsencrypt"

step "restaurando el volumen $VOLUME_NAME"
# El borrado y la extracción ocurren dentro del contenedor, sobre el volumen.
docker run --rm --entrypoint sh \
  -v "$VOLUME_NAME":/data \
  -v "$TMP":/backup:ro \
  "$DESKTOP_IMAGE" -c 'rm -rf /data/* /data/.[!.]* /data/..?* 2>/dev/null; tar xzf /backup/home.tar.gz -C /data' \
  || die 'falló la restauración del volumen.'

# El agente guarda la resolución en el perfil: se conserva tal cual.
if [[ "$START" -eq 1 ]]; then
  log 'arrancando el stack'
  compose up -d
  ok 'stack arrancado'
fi

printf '\n%s\n' "${C_GREEN}${C_BOLD}Restauración completada.${C_RESET}"
printf '%s\n' "Copia de seguridad de la configuración anterior: .env.bak-restore-$STAMP"
printf '%s\n' "Certificados anteriores: data/letsencrypt.bak-$STAMP"
printf '%s\n' "Comprueba con: ./scripts/smoke-test.sh --password-stdin"
