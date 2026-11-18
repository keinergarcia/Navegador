#!/usr/bin/env bash
# =============================================================================
# CloudDesk en GitHub Codespaces (gratuito, sin dominio propio).
#
# Levanta SOLO el contenedor del escritorio (XFCE + Chromium + KasmVNC) y
# publica el puerto 8444 para acceder desde el navegador. No usa el stack
# completo (panel + edge) porque nginx enruta por nombre de host y Codespaces
# expone un único hostname por puerto.
#
# Uso:
#   ./scripts/codespaces-up.sh              # construye y arranca
#   ./scripts/codespaces-up.sh --no-build   # arranca la imagen ya construida
#   ./scripts/codespaces-up.sh --rebuild    # fuerza reconstrucción
#   ./scripts/codespaces-up.sh --status
#   ./scripts/codespaces-up.sh --logs
#   ./scripts/codespaces-up.sh --stop       # elimina el contenedor
#   ./scripts/codespaces-up.sh --check-only # valida Docker (postCreate)
#
# Variables:
#   VNC_PASSWORD   contraseña de KasmVNC (mín. 12; si no, se genera)
#   RESOLUTION     resolución virtual (1366x768)
# =============================================================================
source "$(dirname "$0")/lib.sh"

IMAGE="clouddesk/desktop:codespaces"
CONTAINER="clouddesk-codespaces"
STATE_DIR="$ROOT_DIR/tests/.artifacts"
SECRET_FILE="$STATE_DIR/codespaces-vnc-password"

ACTION="up"
BUILD=1
IF_NEEDED=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-only) ACTION="check" ;;
    --status) ACTION="status" ;;
    --logs) ACTION="logs" ;;
    --stop) ACTION="stop" ;;
    --no-build) BUILD=0 ;;
    --rebuild) BUILD=1 ;;
    --if-needed) IF_NEEDED=1 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "opción desconocida: $1" ;;
  esac
  shift
done

require_docker

if [[ "$ACTION" == "check" ]]; then
  ok "Docker $(docker version --format '{{.Server.Version}}') con compose $(docker compose version --short 2>/dev/null || echo 'n/d')"
  printf '%s\n' "Entorno listo. Ejecuta ./scripts/codespaces-up.sh para arrancar el escritorio."
  exit 0
fi

if [[ "$ACTION" == "status" ]]; then
  docker ps --filter "name=^/${CONTAINER}$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || true
  exit 0
fi

if [[ "$ACTION" == "logs" ]]; then
  docker logs -n 80 -f "$CONTAINER"
  exit 0
fi

if [[ "$ACTION" == "stop" ]]; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  ok "contenedor eliminado"
  exit 0
fi

if [[ "$IF_NEEDED" -eq 1 ]] && docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  ok "el escritorio ya está en marcha"
  exit 0
fi

# ---------------------------------------------------------------------------
# Contraseña persistente entre reinicios del contenedor
# ---------------------------------------------------------------------------
mkdir -p "$STATE_DIR"
PASSWORD="${VNC_PASSWORD:-}"
if [[ -z "$PASSWORD" && -f "$SECRET_FILE" ]]; then
  PASSWORD="$(<"$SECRET_FILE")"
fi
if [[ -z "$PASSWORD" ]]; then
  PASSWORD="$(gen_password)"
  printf '%s' "$PASSWORD" > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
fi
[[ ${#PASSWORD} -ge 12 ]] || die 'VNC_PASSWORD debe tener al menos 12 caracteres.'

AGENT_TOKEN="$(gen_hex 32)"

# ---------------------------------------------------------------------------
# Construcción (XFCE + Chromium + KasmVNC, ~10-20 min la primera vez)
# ---------------------------------------------------------------------------
if [[ "$BUILD" -eq 1 ]]; then
  step 'construyendo la imagen del escritorio'
  docker build -t "$IMAGE" "$ROOT_DIR/desktop"
fi

docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || die "no existe la imagen $IMAGE; ejecuta sin --no-build."

step 'arrancando el escritorio'
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  --restart unless-stopped \
  --shm-size=1g \
  --memory=6g \
  -e TZ="${TZ:-UTC}" \
  -e RESOLUTION="${RESOLUTION:-1366x768}" \
  -e AGENT_TOKEN="$AGENT_TOKEN" \
  -e VNC_USER=desk \
  -e VNC_PASSWORD="$PASSWORD" \
  -e KASMVNC_MAX_FPS="${KASMVNC_MAX_FPS:-30}" \
  -e IDLE_STOP_MINUTES=0 \
  -p 8444:8444 \
  "$IMAGE" >/dev/null

step 'esperando a que KasmVNC responda'
READY=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:8444/" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 2
done
if [[ "$READY" -ne 1 ]]; then
  docker logs --tail=60 "$CONTAINER" || true
  die 'KasmVNC no respondió en 120 s.'
fi

if [[ -n "${CODESPACE_NAME:-}" && -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]]; then
  URL="https://${CODESPACE_NAME}-8444.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
else
  URL="http://127.0.0.1:8444 (o el reenvío del puerto 8444 del editor)"
fi

printf '\n%s\n' "${C_GREEN}${C_BOLD}Escritorio arrancado.${C_RESET}"
printf '  URL        : %s\n' "$URL"
printf '  Usuario    : desk\n'
printf '  Contraseña : %s\n' "$C_BOLD$PASSWORD$C_RESET"
printf '\n%s\n' "El puerto 8444 es privado: solo lo abre tu sesión de GitHub."
printf '%s\n' "Prueba: ./scripts/codespaces-e2e.sh"
printf '%s\n' "Parar:  ./scripts/codespaces-up.sh --stop"
