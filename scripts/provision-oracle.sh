#!/usr/bin/env bash
# =============================================================================
# CloudDesk - aprovisionamiento de una VM Ubuntu 24.04 / Debian (Oracle Cloud
# Always Free, VM.Standard.A1.Flex, 2 OCPU / 12 GB). Idempotente: se puede
# volver a ejecutar sin perder datos ni secretos.
#
# Uso (como root, dentro del repositorio):
#   sudo ./scripts/provision-oracle.sh --domain midominio.com \
#        --email tu@correo.com --password-stdin --yes
#
#   sudo ./scripts/provision-oracle.sh --nip --yes   # sin dominio propio
#
# Opciones:
#   --domain DOMINIO     Dominio base (los hosts serán desk./vnc.DOMINIO).
#   --nip                Usa <IP-publica>.nip.io (sin dominio propio).
#   --email CORREO       Correo de Let's Encrypt (por defecto admin@DOMINIO).
#   --password-stdin     Contraseña del panel por stdin (sin TTY).
#   --resolution WxH     Resolución inicial (1366x768).
#   --yes                Sin preguntas.
#   --skip-cert          No emite certificado (solo deja el autofirmado).
#   --staging            Certificado de pruebas de Let's Encrypt.
#   --no-systemd         No instala las unidades systemd.
#   --harden-ssh         Endurece sshd (solo claves, sin root por contraseña).
#   --force              Regenera .env (¡cambia todos los secretos!).
# =============================================================================
source "$(dirname "$0")/lib.sh"

DOMAIN=""
NIP=0
EMAIL=""
PASSWORD_STDIN=0
RESOLUTION="1366x768"
ASSUME_YES=0
SKIP_CERT=0
STAGING=0
WITH_SYSTEMD=1
HARDEN_SSH=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:?}"; shift 2 ;;
    --nip) NIP=1; shift ;;
    --email) EMAIL="${2:?}"; shift 2 ;;
    --password-stdin) PASSWORD_STDIN=1; shift ;;
    --resolution) RESOLUTION="${2:?}"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --skip-cert) SKIP_CERT=1; shift ;;
    --staging) STAGING=1; shift ;;
    --no-systemd) WITH_SYSTEMD=0; shift ;;
    --harden-ssh) HARDEN_SSH=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "opción desconocida: $1 (usa --help)" ;;
  esac
done

require_root "$@"
[[ -r /etc/os-release ]] || die "no se pudo leer /etc/os-release."
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) die "distribución no soportada: ${ID:-desconocida} (Ubuntu/Debian)." ;;
esac

log "CloudDesk · aprovisionamiento en $PRETTY_NAME ($(dpkg --print-architecture))"

# ---------------------------------------------------------------------------
# 1. Dependencias del sistema
# ---------------------------------------------------------------------------
step 'instalando dependencias base'
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl openssl python3 git tar gpg >/dev/null
ok 'dependencias base presentes'

# ---------------------------------------------------------------------------
# 2. Docker Engine + Compose v2
# ---------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ok 'Docker ya está instalado y en marcha'
else
  step 'instalando Docker Engine + compose v2'
  "$ROOT_DIR/scripts/install-docker.sh"
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 3. Puertos 80/443 en el firewall del sistema operativo
# ---------------------------------------------------------------------------
step 'abriendo 80/tcp y 443/tcp en el firewall del host'
"$ROOT_DIR/scripts/open-ports.sh"
warn 'recuerda abrir 80 y 443 también en la Security List / NSG de Oracle Cloud.'

# ---------------------------------------------------------------------------
# 4. Contraseña del panel
# ---------------------------------------------------------------------------
ADMIN_PASSWORD="${CLOUDDESK_PASSWORD:-}"
if [[ "$PASSWORD_STDIN" -eq 1 && -z "$ADMIN_PASSWORD" ]]; then
  IFS= read -r ADMIN_PASSWORD || true
fi
GENERATED_PASSWORD=0
if [[ -z "$ADMIN_PASSWORD" ]]; then
  ADMIN_PASSWORD="$(gen_password)"
  GENERATED_PASSWORD=1
fi
[[ ${#ADMIN_PASSWORD} -ge 12 ]] || die 'la contraseña debe tener al menos 12 caracteres.'

# ---------------------------------------------------------------------------
# 5. Configuración (.env, secretos, certificado autofirmado) y arranque
# ---------------------------------------------------------------------------
BOOTSTRAP_ARGS=(--resolution "$RESOLUTION" --password-stdin --start)
[[ -n "$DOMAIN" ]] && BOOTSTRAP_ARGS+=(--domain "$DOMAIN")
[[ "$NIP" -eq 1 ]] && BOOTSTRAP_ARGS+=(--nip)
[[ -n "$EMAIL" ]] && BOOTSTRAP_ARGS+=(--email "$EMAIL")
[[ "$ASSUME_YES" -eq 1 ]] && BOOTSTRAP_ARGS+=(--yes)
[[ "$FORCE" -eq 1 ]] && BOOTSTRAP_ARGS+=(--force)

if [[ -f "$ENV_FILE" && "$FORCE" -ne 1 ]]; then
  warn '.env ya existe: se conservan los secretos actuales.'
  step 'recreando servicios con la configuración existente'
  compose up -d --remove-orphans
else
  step 'generando configuración y arrancando el stack'
  printf '%s\n' "$ADMIN_PASSWORD" | "$ROOT_DIR/scripts/bootstrap.sh" "${BOOTSTRAP_ARGS[@]}"
fi

load_env

step 'esperando a que el panel responda por HTTPS (certificado autofirmado)'
WAITED=0
until curl -fsSk --max-time 4 --resolve "$PANEL_HOST:443:127.0.0.1" \
        "https://$PANEL_HOST/healthz" 2>/dev/null | grep -q ok; do
  WAITED=$((WAITED + 5))
  if [[ "$WAITED" -ge 300 ]]; then
    compose logs --tail=80
    die "el panel no respondió en 5 minutos (https://$PANEL_HOST/healthz)."
  fi
  sleep 5
done
ok 'panel operativo por HTTPS'

# ---------------------------------------------------------------------------
# 6. DNS + certificado Let's Encrypt
# ---------------------------------------------------------------------------
PUBLIC_IP="$(public_ipv4 || true)"
if [[ "$SKIP_CERT" -eq 1 ]]; then
  warn 'emisión de certificado omitida (--skip-cert).'
elif [[ -z "$PUBLIC_IP" ]]; then
  warn 'no se pudo detectar la IP pública; no se emite certificado.'
else
  step "esperando a que $PANEL_HOST y $VNC_HOST resuelvan a $PUBLIC_IP"
  DNS_OK=0
  for _ in $(seq 1 30); do
    if dns_ipv4 "$PANEL_HOST" | grep -qw "$PUBLIC_IP" \
       && dns_ipv4 "$VNC_HOST" | grep -qw "$PUBLIC_IP"; then
      DNS_OK=1
      break
    fi
    sleep 10
  done
  if [[ "$DNS_OK" -eq 1 ]]; then
    CERT_ARGS=()
    [[ "$STAGING" -eq 1 ]] && CERT_ARGS+=(--staging)
    if "$ROOT_DIR/scripts/issue-cert.sh" "${CERT_ARGS[@]}"; then
      ok "certificado Let's Encrypt emitido"
    else
      warn 'la emisión del certificado falló; el panel sigue con el autofirmado.'
      warn "reintenta con: ./scripts/issue-cert.sh ${CERT_ARGS[*]:-}"
    fi
  else
    warn "el DNS aún no apunta a $PUBLIC_IP."
    warn "crea los registros A de $PANEL_HOST y $VNC_HOST y ejecuta ./scripts/issue-cert.sh"
  fi
fi

# ---------------------------------------------------------------------------
# 7. Reinicio automático con systemd
# ---------------------------------------------------------------------------
if [[ "$WITH_SYSTEMD" -eq 1 ]]; then
  step 'instalando unidades systemd (arranque tras reiniciar la VM)'
  install -m 0644 "$ROOT_DIR"/deploy/systemd/*.service "$ROOT_DIR"/deploy/systemd/*.timer \
    /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now docker >/dev/null 2>&1 || true
  systemctl enable clouddesk.service clouddesk-renew.timer clouddesk-backup.timer >/dev/null 2>&1 || true
  ok 'clouddesk.service habilitado'
fi

if [[ "$HARDEN_SSH" -eq 1 ]]; then
  step 'endureciendo sshd'
  "$ROOT_DIR/scripts/harden-ssh.sh"
fi

# ---------------------------------------------------------------------------
# 8. Prueba de humo
# ---------------------------------------------------------------------------
if [[ "$ASSUME_YES" -eq 1 ]]; then
  step 'prueba de humo'
  printf '%s\n' "$ADMIN_PASSWORD" | "$ROOT_DIR/scripts/smoke-test.sh" --password-stdin --insecure \
    || warn 'la prueba de humo encontró fallos; revisa los registros.'
fi

# ---------------------------------------------------------------------------
# 9. Resumen
# ---------------------------------------------------------------------------
printf '\n%s\n' "${C_GREEN}${C_BOLD}Aprovisionamiento completado.${C_RESET}"
printf '  Panel      : https://%s\n' "$PANEL_HOST"
printf '  Escritorio : https://%s\n' "$VNC_HOST"
printf '  Contraseña : '
if [[ "$GENERATED_PASSWORD" -eq 1 ]]; then
  printf '%s (generada; guárdala ahora)\n' "$C_BOLD$ADMIN_PASSWORD$C_RESET"
else
  printf '%s\n' 'la que indicaste'
fi
printf '\n%s\n' "Siguiente paso: abre el panel y ejecuta la prueba E2E (docs/PRUEBA-E2E.md)."
