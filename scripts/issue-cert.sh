#!/usr/bin/env bash
# =============================================================================
# CloudDesk - emite el certificado real de Let's Encrypt (HTTP-01).
#
# Requisitos:
#   - DNS: registros A de PANEL_HOST y VNC_HOST apuntando a esta máquina.
#   - Puertos 80 y 443 abiertos (scripts/open-ports.sh + Security List de OCI).
#   - Stack arrancado (el reto se sirve desde nginx en el puerto 80).
#
# Uso: ./scripts/issue-cert.sh [--skip-dns] [--force] [--staging]
#
#   --skip-dns   No comprueba que el DNS apunte a la IP pública (útil con
#                Cloudflare proxy o DNS aún propagándose).
#   --force      Reemplaza un certificado ya emitido (no autofirmado).
#   --staging    Usa el entorno de pruebas de Let's Encrypt (no válido para
#                navegadores, pero no consume cuotas). Útil para depurar.
# =============================================================================
source "$(dirname "$0")/lib.sh"

SKIP_DNS=0
FORCE=0
STAGING=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-dns) SKIP_DNS=1; shift ;;
    --force) FORCE=1; shift ;;
    --staging) STAGING=1; shift ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "opción desconocida: $1" ;;
  esac
done

require_cmd docker curl openssl
load_env
require_docker

compose ps --status running --services 2>/dev/null | grep -qx edge \
  || die "el contenedor edge no está en marcha. Ejecuta: docker compose up -d"

printf '%s\n' "${C_BOLD}Comprobaciones previas${C_RESET}"

# --- DNS ---------------------------------------------------------------------
PUBLIC_IP="$(public_ipv4 || true)"
if [[ -z "$PUBLIC_IP" ]]; then
  warn 'no se pudo detectar la IP pública; se omite la comprobación de DNS.'
  SKIP_DNS=1
fi

if [[ "$SKIP_DNS" -eq 0 ]]; then
  for host in "$PANEL_HOST" "$VNC_HOST"; do
    ips="$(dns_ipv4 "$host" | tr '\n' ' ')"
    if [[ -z "${ips// /}" ]]; then
      die "$host no resuelve. Crea el registro A -> $PUBLIC_IP y espera la propagación."
    fi
    if ! grep -qw "$PUBLIC_IP" <<<"$ips"; then
      warn "$host resuelve a: $ips (IP de esta máquina: $PUBLIC_IP)."
      die "el DNS no apunta aquí. Corrige los registros o usa --skip-dns si usas un proxy (Cloudflare)."
    fi
    ok "$host -> $PUBLIC_IP"
  done
else
  warn 'comprobación de DNS omitida (--skip-dns).'
fi

# --- Puerto 80 accesible desde fuera ----------------------------------------
step 'comprobando el reto ACME a través del puerto 80'
PROBE="clouddesk-probe-$(gen_hex 4)"
mkdir -p "$ROOT_DIR/data/certbot-www/.well-known/acme-challenge"
printf '%s' "$PROBE" > "$ROOT_DIR/data/certbot-www/.well-known/acme-challenge/$PROBE"
PROBE_URL="http://$PANEL_HOST/.well-known/acme-challenge/$PROBE"
if ! RECEIVED="$(curl -fsS --max-time 10 "$PROBE_URL" 2>/dev/null)"; then
  rm -f "$ROOT_DIR/data/certbot-www/.well-known/acme-challenge/$PROBE"
  die "no se pudo leer $PROBE_URL. Revisa el puerto 80 (firewall de OCI y scripts/open-ports.sh)."
fi
rm -f "$ROOT_DIR/data/certbot-www/.well-known/acme-challenge/$PROBE"
[[ "$RECEIVED" == "$PROBE" ]] || die "el reto ACME devolvió contenido inesperado. ¿Hay otro servidor en el puerto 80?"
ok 'puerto 80 accesible y sirviendo data/certbot-www'

# --- Certificado existente ---------------------------------------------------
LIVE_DIR="$ROOT_DIR/data/letsencrypt/live/$PANEL_HOST"
if [[ -f "$LIVE_DIR/fullchain.pem" ]]; then
  SUBJECT="$(openssl x509 -in "$LIVE_DIR/fullchain.pem" -noout -subject 2>/dev/null || true)"
  ISSUER="$(openssl x509 -in "$LIVE_DIR/fullchain.pem" -noout -issuer 2>/dev/null || true)"
  # Autofirmado: emisor == sujeto (el CN coincide).
  SELF_SIGNED=0
  [[ "$SUBJECT" == "$ISSUER" ]] && SELF_SIGNED=1
  if [[ "$SELF_SIGNED" -eq 0 && "$FORCE" -ne 1 ]]; then
    ok "ya existe un certificado emitido por: $ISSUER"
    printf '%s\n' "Para renovarlo usa ./scripts/renew-cert.sh; para reemplazarlo, --force."
    exit 0
  fi
  step 'apartando el certificado autofirmado'
  ARCHIVE_DIR="$ROOT_DIR/data/selfsigned/previous-live-$(date +%Y%m%d-%H%M%S)"
  mv "$LIVE_DIR" "$ARCHIVE_DIR"
  ok "copia en $ARCHIVE_DIR"
fi

# --- Emisión -----------------------------------------------------------------
CERTBOT_ARGS=(
  certonly --webroot -w /var/www/certbot
  --cert-name "$PANEL_HOST"
  -d "$PANEL_HOST" -d "$VNC_HOST"
  --email "$ACME_EMAIL"
  --agree-tos --no-eff-email --non-interactive
)
if [[ "$STAGING" -eq 1 ]]; then
  CERTBOT_ARGS+=(--staging)
  warn 'usando el entorno STAGING: el certificado NO será válido en navegadores.'
fi
if [[ "$FORCE" -eq 1 ]]; then
  CERTBOT_ARGS+=(--force-renewal)
else
  CERTBOT_ARGS+=(--keep-until-expiring)
fi

log 'solicitando el certificado a Let'"'"'s Encrypt'
compose --profile tls run --rm certbot "${CERTBOT_ARGS[@]}"

[[ -f "$LIVE_DIR/fullchain.pem" ]] || die "certbot terminó pero no se encontró $LIVE_DIR/fullchain.pem."

# certbot escribe como root dentro del contenedor; devolvemos la propiedad al
# usuario que ejecuta el script para que futuras reemisiones puedan mover live/.
if [[ "${EUID}" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
  sudo chown -R "$(id -u):$(id -g)" "$ROOT_DIR/data/letsencrypt" "$ROOT_DIR/data/certbot-www" 2>/dev/null \
    || warn 'no se pudo ajustar la propiedad de data/letsencrypt (revisa permisos si reemites).'
fi

step 'recargando nginx'
compose exec -T edge nginx -s reload
ok 'nginx recargado'

printf '\n'
openssl x509 -in "$LIVE_DIR/fullchain.pem" -noout -subject -issuer -dates \
  -ext subjectAltName 2>/dev/null | sed 's/^/  /'
printf '\n'
printf '%s\n' "${C_GREEN}${C_BOLD}HTTPS listo.${C_RESET} Abre https://$PANEL_HOST en el iPhone."
printf '%s\n' "Comprueba todo con: ./scripts/smoke-test.sh --password"
