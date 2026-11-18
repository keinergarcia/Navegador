#!/usr/bin/env bash
# =============================================================================
# CloudDesk - configuración inicial.
#
# Genera .env con secretos aleatorios, crea un certificado autofirmado temporal
# (para que nginx arranque siempre) y prepara los directorios de datos.
#
# Uso:
#   ./scripts/bootstrap.sh [opciones]
#
# Opciones:
#   --domain DOMINIO        Dominio base (ej. midominio.com).
#   --nip                   Sin dominio propio: usa <IP-publica>.nip.io.
#   --panel HOST            Host del panel (por defecto desk.DOMINIO).
#   --vnc HOST              Host del escritorio (por defecto vnc.DOMINIO).
#   --cookie-domain DOM    Dominio de la cookie (por defecto .DOMINIO).
#   --email CORREO          Correo para Let's Encrypt.
#   --tz ZONA               Zona horaria (por defecto la del sistema).
#   --resolution WxH        Resolución inicial (por defecto 1366x768).
#   --password-stdin        Lee la contraseña del panel de stdin (sin TTY).
#   --start                 Construye y arranca al terminar.
#   --no-start              No arranca (por defecto pregunta).
#   --force                 Sobrescribe un .env existente.
#   --yes                   No pregunta nada (modo desatendido).
# =============================================================================
source "$(dirname "$0")/lib.sh"

DOMAIN=""
NIP=0
PANEL=""
VNC=""
COOKIE_DOMAIN=""
EMAIL=""
TZ_VALUE=""
RESOLUTION="1366x768"
PASSWORD_STDIN=0
START="" # vacío = preguntar
FORCE=0
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:?}"; shift 2 ;;
    --nip) NIP=1; shift ;;
    --panel) PANEL="${2:?}"; shift 2 ;;
    --vnc) VNC="${2:?}"; shift 2 ;;
    --cookie-domain) COOKIE_DOMAIN="${2:?}"; shift 2 ;;
    --email) EMAIL="${2:?}"; shift 2 ;;
    --tz) TZ_VALUE="${2:?}"; shift 2 ;;
    --resolution) RESOLUTION="${2:?}"; shift 2 ;;
    --password-stdin) PASSWORD_STDIN=1; shift ;;
    --start) START=1; shift ;;
    --no-start) START=0; shift ;;
    --force) FORCE=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "opción desconocida: $1 (usa --help)" ;;
  esac
done

require_cmd python3 openssl curl
require_docker

if [[ -f "$ENV_FILE" && "$FORCE" -ne 1 ]]; then
  die "$ENV_FILE ya existe. Usa --force para regenerarlo (se perderán los secretos actuales)."
fi

printf '%s\n' "${C_BOLD}CloudDesk · configuración inicial${C_RESET}"
printf '%s\n' "${C_DIM}Los secretos se generan localmente y solo se escriben en .env (modo 600).${C_RESET}"
printf '\n'

# --- Dominios ----------------------------------------------------------------
if [[ "$NIP" -eq 1 && -n "$DOMAIN" ]]; then
  die "usa --domain o --nip, no ambos."
fi
if [[ "$NIP" -eq 1 ]]; then
  # Sin dominio propio: <IP-publica>.nip.io resuelve a la propia máquina.
  # nip.io no está en la Public Suffix List, así que la cookie de sesión con
  # Domain=.IP.nip.io funciona en los navegadores.
  NIP_IP="$(public_ipv4 || true)"
  [[ -n "$NIP_IP" ]] || die "no se pudo detectar la IP pública; usa --domain con un dominio real."
  DOMAIN="${NIP_IP}.nip.io"
  warn "modo nip.io: el certificado Let's Encrypt comparte cuota con todos los usuarios de nip.io."
  warn "para producción usa un dominio propio; para pruebas, ./scripts/issue-cert.sh --staging"
fi
if [[ -z "$DOMAIN" ]]; then
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    die "modo --yes requiere --domain o --nip."
  fi
  if [[ -t 0 ]]; then
    DOMAIN="$(prompt_value 'Dominio base' 'example.com')"
  else
    die "falta --domain (o --nip). Ejemplo: --domain midominio.com"
  fi
fi
DOMAIN="${DOMAIN,,}"
validate_hostname "$DOMAIN"

[[ -n "$PANEL" ]] || PANEL="${PANEL_HOST:-desk.$DOMAIN}"
[[ -n "$VNC" ]] || VNC="${VNC_HOST:-vnc.$DOMAIN}"
PANEL="${PANEL,,}"
VNC="${VNC,,}"
validate_hostname "$PANEL"
validate_hostname "$VNC"
[[ "$PANEL" != "$VNC" ]] || die "el panel y el escritorio deben usar hosts distintos."

if [[ -z "$COOKIE_DOMAIN" ]]; then
  COOKIE_DOMAIN=".$DOMAIN"
fi
if [[ "$COOKIE_DOMAIN" != .* ]]; then
  die "el dominio de cookie debe empezar por punto (ej. .$DOMAIN)."
fi
BASE_DOMAIN_VALUE="${COOKIE_DOMAIN#.}"
for host in "$PANEL" "$VNC"; do
  if [[ "$host" != "$BASE_DOMAIN_VALUE" && "$host" != *".$BASE_DOMAIN_VALUE" ]]; then
    die "$host no pertenece a $COOKIE_DOMAIN; la cookie de sesión no llegaría."
  fi
done

if [[ -z "$EMAIL" ]]; then
  if [[ -t 0 ]]; then
    EMAIL="$(prompt_value "Correo para Let's Encrypt" "${ACME_EMAIL:-admin@$DOMAIN}")"
  else
    EMAIL="${ACME_EMAIL:-admin@$DOMAIN}"
  fi
fi
validate_email "$EMAIL"

if [[ -z "$TZ_VALUE" ]]; then
  TZ_VALUE="${TZ:-}"
fi
if [[ -z "$TZ_VALUE" ]]; then
  if command -v timedatectl >/dev/null 2>&1; then
    TZ_VALUE="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  fi
  [[ -n "$TZ_VALUE" ]] || TZ_VALUE="UTC"
fi

validate_resolution "$RESOLUTION"

# --- Contraseña del panel ----------------------------------------------------
ADMIN_PASSWORD=""
if [[ "$PASSWORD_STDIN" -eq 1 ]]; then
  IFS= read -r ADMIN_PASSWORD || true
  [[ -n "$ADMIN_PASSWORD" ]] || die "--password-stdin no recibió ninguna contraseña."
elif [[ -n "${CLOUDDESK_PASSWORD:-}" ]]; then
  ADMIN_PASSWORD="$CLOUDDESK_PASSWORD"
elif [[ -t 0 ]]; then
  while true; do
    read -r -s -p 'Contraseña del panel (mín. 12 caracteres): ' ADMIN_PASSWORD || true
    printf '\n'
    [[ ${#ADMIN_PASSWORD} -ge 12 ]] || { warn "demasiado corta."; continue; }
    repeated=""
    read -r -s -p 'Repite la contraseña: ' repeated || true
    printf '\n'
    [[ "$ADMIN_PASSWORD" == "$repeated" ]] && break
    warn "no coinciden. Inténtalo de nuevo."
  done
  unset repeated
else
  ADMIN_PASSWORD="$(gen_password)"
  warn "sin TTY: se ha generado una contraseña aleatoria. Se mostrará una sola vez al final."
fi
[[ ${#ADMIN_PASSWORD} -ge 12 ]] || die "la contraseña debe tener al menos 12 caracteres."

printf '\n'
printf '%s\n' "  Dominio base : ${C_BOLD}$DOMAIN${C_RESET}"
printf '%s\n' "  Panel        : ${C_BOLD}https://$PANEL${C_RESET}"
printf '%s\n' "  Escritorio   : ${C_BOLD}https://$VNC${C_RESET}"
printf '%s\n' "  Cookie       : $COOKIE_DOMAIN"
printf '%s\n' "  Let's Encrypt: $EMAIL"
printf '%s\n' "  Zona horaria : $TZ_VALUE"
printf '%s\n' "  Resolución   : $RESOLUTION"
printf '\n'

if [[ "$START" == "" && "$ASSUME_YES" -eq 1 ]]; then
  START=1
fi
if [[ "$START" == "" && -t 0 ]]; then
  if confirm '¿Construir y arrancar ahora?' y; then START=1; else START=0; fi
fi

# --- Secretos ----------------------------------------------------------------
SESSION_SECRET="$(gen_hex 32)"
AGENT_TOKEN="$(gen_hex 32)"
VNC_PASSWORD="$(gen_password)"
VNC_AUTH_B64="$(printf '%s:%s' "${VNC_USER:-desk}" "$VNC_PASSWORD" | openssl base64 -A)"

step 'creando directorios de datos'
mkdir -p "$ROOT_DIR/data/letsencrypt" "$ROOT_DIR/data/certbot-www" \
         "$ROOT_DIR/data/selfsigned" "$ROOT_DIR/backups"
chmod 700 "$ROOT_DIR/data" "$ROOT_DIR/backups"
chmod 755 "$ROOT_DIR/data/certbot-www"

step 'generando certificado autofirmado temporal'
SELF_KEY="$ROOT_DIR/data/selfsigned/privkey.pem"
SELF_CRT="$ROOT_DIR/data/selfsigned/fullchain.pem"
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$SELF_KEY" -out "$SELF_CRT" \
  -subj "/CN=$PANEL" \
  -addext "subjectAltName=DNS:$PANEL,DNS:$VNC" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1
chmod 600 "$SELF_KEY"
chmod 644 "$SELF_CRT"

LIVE_DIR="$ROOT_DIR/data/letsencrypt/live/$PANEL"
mkdir -p "$LIVE_DIR"
cp "$SELF_CRT" "$LIVE_DIR/fullchain.pem"
cp "$SELF_KEY" "$LIVE_DIR/privkey.pem"
chmod 644 "$LIVE_DIR/fullchain.pem"
chmod 600 "$LIVE_DIR/privkey.pem"
ok "certificado autofirmado en data/letsencrypt/live/$PANEL"

# --- .env --------------------------------------------------------------------
step 'generando secretos y escribiendo .env'
PASSWORD_HASH="$(printf '%s' "$ADMIN_PASSWORD" | hash_password)"

if [[ -f "$ENV_FILE" ]]; then
  cp "$ENV_FILE" "$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
fi
cat > "$ENV_FILE" <<EOF
# =============================================================================
# CloudDesk - configuración generada por scripts/bootstrap.sh
# Contiene secretos: NO lo subas a git ni lo compartas. Modo 600.
# Generado: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
# =============================================================================

BASE_DOMAIN='$DOMAIN'
PANEL_HOST='$PANEL'
VNC_HOST='$VNC'
COOKIE_DOMAIN='$COOKIE_DOMAIN'
ACME_EMAIL='$EMAIL'
TZ='$TZ_VALUE'

AUTH_PASSWORD_HASH='$PASSWORD_HASH'
SESSION_SECRET='$SESSION_SECRET'
AGENT_TOKEN='$AGENT_TOKEN'
VNC_USER='${VNC_USER:-desk}'
VNC_PASSWORD='$VNC_PASSWORD'
VNC_AUTH_B64='$VNC_AUTH_B64'

SESSION_HOURS=12
REMEMBER_DAYS=30
LOGIN_MAX_ATTEMPTS=5
LOGIN_WINDOW_MINUTES=15

RESOLUTION='$RESOLUTION'
KASMVNC_MAX_FPS=30
KASMVNC_QUALITY_MIN=6
KASMVNC_QUALITY_MAX=8
CHROMIUM_FLAGS=
IDLE_STOP_MINUTES=30

DESKTOP_CPUS=1.8
DESKTOP_MEM_LIMIT=8g
SHM_SIZE=1g
EOF
chmod 600 "$ENV_FILE"
ok ".env creado (modo 600)"

printf '\n'
printf '%s\n' "${C_GREEN}${C_BOLD}Configuración completada.${C_RESET}"
printf '\n'
printf '%s\n' "Siguientes pasos:"
printf '%s\n' "  1. DNS: crea registros A para $PANEL y $VNC apuntando a la IP pública."
printf '%s\n' "  2. Firewall: sudo ./scripts/open-ports.sh   (y abre 80/443 en la Security List de OCI)."
printf '%s\n' "  3. Arranque:  docker compose up -d --build"
printf '%s\n' "  4. Certificado real: ./scripts/issue-cert.sh"
printf '%s\n' "  5. Comprobación: ./scripts/smoke-test.sh"
printf '\n'
printf '%s\n' "Usuario del panel: único (sin nombre). Contraseña: la que acabas de definir."

if [[ "$PASSWORD_STDIN" -eq 0 && ! -t 0 ]]; then
  printf '\n%s\n' "${C_YELLOW}Contraseña generada (guárdala ahora):${C_RESET} ${C_BOLD}$ADMIN_PASSWORD${C_RESET}"
  printf '%s\n' "Puedes cambiarla luego con: ./scripts/set-password.sh"
fi

if [[ "$START" == "1" ]]; then
  log 'construyendo y arrancando los contenedores'
  compose up -d --build
  ok 'stack arrancado'
  printf '\n%s\n' "El panel responderá en https://$PANEL (certificado autofirmado hasta que emitas el real)."
  printf '%s\n' "Sigue los registros con: docker compose logs -f --tail=100"
fi
