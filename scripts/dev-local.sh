#!/usr/bin/env bash
# =============================================================================
# CloudDesk - entorno local de desarrollo (sin Docker).
#
# Arranca:
#   - un agente simulado (api/tools/mock-agent.mjs)
#   - el API real (api/src/server.js) en modo cookies inseguras
#   - un proxy estático + /api (api/tools/dev-proxy.mjs)
#
# Uso: ./scripts/dev-local.sh [--lan]
#   Panel:      http://127.0.0.1:8088
#   Contraseña: clouddesk-dev-password (o CLOUDDESK_DEV_PASSWORD)
#
#   --lan  escucha en 0.0.0.0 y muestra la URL de tu red local para probar
#          desde el iPhone. Solo para desarrollo: HTTP sin cifrar y con una
#          contraseña conocida.
#
#   DEV_VNC_URL=https://...   carga esa URL en el iframe del visor en lugar
#          del mock. Útil para probar una web concreta, pero NO convierte
#          CloudDesk en un escritorio: sigue sin haber XFCE/Chromium.
#
# El visor apunta a /vnc-mock: una página que avisa de que NO es KasmVNC.
# Para probar el escritorio real hace falta el stack completo con Docker.
# =============================================================================
source "$(dirname "$0")/lib.sh"

LAN=0
for arg in "$@"; do
  case "$arg" in
    --lan) LAN=1 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "opción desconocida: $arg" ;;
  esac
done

require_cmd node curl
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "se necesita Node.js 20 o superior (detectado $(node -v))."

DEV_PASSWORD="${CLOUDDESK_DEV_PASSWORD:-clouddesk-dev-password}"
[[ ${#DEV_PASSWORD} -ge 12 ]] || die "CLOUDDESK_DEV_PASSWORD debe tener al menos 12 caracteres."

API_PORT="${API_PORT:-18080}"
PROXY_PORT="${PROXY_PORT:-8088}"
MOCK_PORT="${MOCK_PORT:-18099}"

ACCESS_HOST="127.0.0.1"
PROXY_HOST="127.0.0.1"
if [[ "$LAN" -eq 1 ]]; then
  LAN_IP="$(node -e 'const os=require("os"); for (const list of Object.values(os.networkInterfaces())) for (const a of list||[]) if (a.family==="IPv4" && !a.internal) { console.log(a.address); process.exit(0); } process.exit(1);')" \
    || die 'no se pudo detectar una IPv4 local; usa sin --lan o define DEV_HOST.'
  [[ -n "$LAN_IP" ]] || die 'no se pudo detectar una IPv4 local.'
  ACCESS_HOST="$LAN_IP"
  PROXY_HOST="0.0.0.0"
fi
PANEL_ORIGIN="http://$ACCESS_HOST:$PROXY_PORT"
VNC_TARGET="${DEV_VNC_URL:-$PANEL_ORIGIN/vnc-mock}"

step 'calculando el hash de la contraseña de desarrollo'
HASH="$(printf '%s' "$DEV_PASSWORD" | node "$ROOT_DIR/api/src/cli.js" hash-password)" \
  || die 'no se pudo calcular el hash.'

PIDS=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

step 'arrancando el agente simulado'
AGENT_TOKEN="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" \
  node "$ROOT_DIR/api/tools/mock-agent.mjs" "$MOCK_PORT" &
PIDS+=($!)

step 'arrancando el API'
(
  export PORT="$API_PORT"
  export NODE_ENV=development
  export APP_VERSION=dev
  export AUTH_PASSWORD_HASH="$HASH"
  export SESSION_SECRET=dev-session-secret-0123456789abcdef0123456789abcdef
  export AGENT_TOKEN=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  export AGENT_URL="http://127.0.0.1:$MOCK_PORT"
  export INSECURE_COOKIES=1
  export BIND_HOST=127.0.0.1
  export PANEL_ORIGIN="$PANEL_ORIGIN"
  export VNC_URL="$VNC_TARGET"
  export VNC_HOST="$ACCESS_HOST"
  exec node "$ROOT_DIR/api/src/server.js"
) &
PIDS+=($!)

if ! wait_http "http://127.0.0.1:$API_PORT/api/health" 20; then
  die "el API no arrancó en el puerto $API_PORT."
fi

step 'arrancando el proxy del panel'
PROXY_TARGET="http://127.0.0.1:$API_PORT" HOST="$PROXY_HOST" \
  node "$ROOT_DIR/api/tools/dev-proxy.mjs" "$PROXY_PORT" &
PIDS+=($!)

if ! wait_http "http://127.0.0.1:$PROXY_PORT/" 20; then
  die "el proxy no arrancó en el puerto $PROXY_PORT."
fi

printf '\n%s\n' "${C_GREEN}${C_BOLD}Entorno local listo.${C_RESET}"
if [[ "$LAN" -eq 1 ]]; then
  printf '  Panel (red local): http://%s:%s\n' "$ACCESS_HOST" "$PROXY_PORT"
  printf '  Panel (este PC):   http://127.0.0.1:%s\n' "$PROXY_PORT"
  printf '\n%s\n' "${C_YELLOW}Abre la URL de red local desde el iPhone (misma Wi-Fi).${C_RESET}"
  printf '%s\n' "Es HTTP sin cifrar y con contraseña de desarrollo: solo para pruebas."
  printf '%s\n' "Si el iPhone no carga, permite Node.js en el Firewall de Windows."
else
  printf '  Panel:      http://127.0.0.1:%s\n' "$PROXY_PORT"
fi
printf '  Visor:      %s\n' "$VNC_TARGET"
printf '  API:        http://127.0.0.1:%s/api/health\n' "$API_PORT"
printf '  Contraseña: %s\n' "$DEV_PASSWORD"
printf '\n%s\n' "Pulsa Ctrl+C para detener todo."

wait
