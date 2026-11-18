#!/usr/bin/env bash
# =============================================================================
# CloudDesk - renueva los certificados y recarga nginx.
#
# Pensado para ejecutarse desde el temporizador systemd (deploy/systemd/
# clouddesk-renew.timer), pero puede lanzarse a mano.
#
# Uso: ./scripts/renew-cert.sh [--dry-run] [--quiet]
#
# Certbot solo renueva si quedan menos de 30 días. La recarga de nginx es
# inocua aunque no se haya renovado nada.
# =============================================================================
source "$(dirname "$0")/lib.sh"

DRY_RUN=0
QUIET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "opción desconocida: $1" ;;
  esac
done

require_cmd docker
load_env
require_docker

LIVE_DIR="$ROOT_DIR/data/letsencrypt/live/$PANEL_HOST"
if [[ ! -f "$LIVE_DIR/fullchain.pem" ]]; then
  warn "no hay certificado en $LIVE_DIR; nada que renovar (ejecuta issue-cert.sh)."
  exit 0
fi

ARGS=(renew --webroot -w /var/www/certbot --quiet)
[[ "$DRY_RUN" -eq 1 ]] && ARGS+=(--dry-run)

log 'ejecutando certbot renew'
if ! OUTPUT="$(compose --profile tls run --rm certbot "${ARGS[@]}" 2>&1)"; then
  printf '%s\n' "$OUTPUT" >&2
  die 'certbot renew falló.'
fi
[[ "$QUIET" -eq 0 ]] && printf '%s\n' "$OUTPUT"

if compose ps --status running --services 2>/dev/null | grep -qx edge; then
  compose exec -T edge nginx -s reload
  ok 'nginx recargado'
else
  warn 'edge no está en marcha; nginx cargará el certificado al arrancar.'
fi

openssl x509 -in "$LIVE_DIR/fullchain.pem" -noout -enddate | sed 's/^/  /'
ok 'renovación completada (si procedía)'
