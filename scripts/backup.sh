#!/usr/bin/env bash
# =============================================================================
# CloudDesk - copia de seguridad de .env, certificados y perfil del escritorio.
#
# Uso:
#   ./scripts/backup.sh [--keep N] [--dir RUTA]
#
# Genera backups/clouddesk-AAAAMMDD-HHMMSS.tar.gz (+ .sha256) con:
#   - .env (secretos y configuración)
#   - data/letsencrypt (certificados y cuentas de certbot)
#   - home.tar.gz del volumen clouddesk_desktop_home (perfil de Chromium,
#     descargas, configuración de XFCE)
#
# Los archivos contienen secretos: se crean con modo 600. Cópialos fuera del
# servidor (por ejemplo, con scp) y guárdalos cifrados.
# =============================================================================
source "$(dirname "$0")/lib.sh"

KEEP="${BACKUP_KEEP:-7}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP="${2:?}"; shift 2 ;;
    --dir) BACKUP_DIR="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "opción desconocida: $1" ;;
  esac
done

require_cmd docker tar sha256sum
load_env
require_docker

DESKTOP_IMAGE="${DESKTOP_IMAGE:-clouddesk/desktop:1.5.2}"
VOLUME_NAME="${VOLUME_NAME:-clouddesk_desktop_home}"

docker image inspect "$DESKTOP_IMAGE" >/dev/null 2>&1 \
  || die "no existe la imagen $DESKTOP_IMAGE. Ejecuta: docker compose build"
docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1 \
  || die "no existe el volumen $VOLUME_NAME. ¿Has arrancado el stack alguna vez?"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP="$(date -u '+%Y%m%d-%H%M%S')"
OUT="$BACKUP_DIR/clouddesk-$STAMP.tar.gz"
TMP="$(mktemp -d "$BACKUP_DIR/.tmp.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

log 'empaquetando el perfil del escritorio'
docker run --rm --entrypoint tar \
  -v "$VOLUME_NAME":/data:ro \
  -v "$TMP":/backup \
  "$DESKTOP_IMAGE" czf /backup/home.tar.gz -C /data . \
  || die 'no se pudo empaquetar el volumen del escritorio.'

cat > "$TMP/manifest.txt" <<EOF
CloudDesk backup
created_utc=$STAMP
panel_host=$PANEL_HOST
vnc_host=$VNC_HOST
desktop_image=$DESKTOP_IMAGE
volume=$VOLUME_NAME
EOF

log 'creando el archivo final'
tar -czf "$OUT" -C "$ROOT_DIR" .env data/letsencrypt \
  -C "$TMP" home.tar.gz manifest.txt
chmod 600 "$OUT"

if ! tar -tzf "$OUT" >/dev/null 2>&1; then
  rm -f "$OUT"
  die 'el archivo generado no se puede leer; se ha eliminado.'
fi

(cd "$BACKUP_DIR" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
chmod 600 "$OUT.sha256"

ok "backup: $OUT ($(du -h "$OUT" | cut -f1))"

# --- Retención ---------------------------------------------------------------
if [[ "$KEEP" =~ ^[0-9]+$ ]] && [[ "$KEEP" -gt 0 ]]; then
  mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/clouddesk-*.tar.gz 2>/dev/null || true)
  if [[ "${#OLD[@]}" -gt "$KEEP" ]]; then
    for file in "${OLD[@]:$KEEP}"; do
      rm -f "$file" "$file.sha256"
      step "eliminado por retención: $(basename "$file")"
    done
  fi
fi

printf '\n%s\n' "Verifica con: sha256sum -c $(basename "$OUT").sha256"
printf '%s\n' "Cópialo fuera del servidor: scp $OUT usuario@tu-equipo:"
