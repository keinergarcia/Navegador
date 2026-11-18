#!/usr/bin/env bash
# =============================================================================
# CloudDesk - prueba real en Codespaces.
#
#   1. Verifica que el contenedor del escritorio está vivo.
#   2. Espera a que Chromium exponga CDP (127.0.0.1:9222).
#   3. Ejecuta la verificación de esMovil() del despliegue de Apps Script.
#   4. Abre la app dentro del Chromium real (X11, ratón, 1366x768) y comprueba
#      que NO se detecta como móvil y que no aparece el bloqueo.
#
# Uso:
#   ./scripts/codespaces-e2e.sh
#   ./scripts/codespaces-e2e.sh --url "https://script.google.com/macros/s/.../exec"
#   ./scripts/codespaces-e2e.sh --skip-deteccion
#
# Códigos de salida:
#   0  detección correcta y escritorio verificado
#   1  algún control falló
#   2  pendiente: la app no expuso esMovil() (login o URL)
# =============================================================================
source "$(dirname "$0")/lib.sh"

CONTAINER="clouddesk-codespaces"
CDP_URL="http://127.0.0.1:9222"
APP_URL=""
SKIP_DETECCION=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) APP_URL="${2:?}"; shift 2 ;;
    --cdp) CDP_URL="${2:?}"; shift 2 ;;
    --skip-deteccion) SKIP_DETECCION=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "opción desconocida: $1" ;;
  esac
done

require_cmd node curl
require_docker

docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true \
  || die "el contenedor $CONTAINER no está en marcha. Ejecuta ./scripts/codespaces-up.sh"

step 'esperando a Chromium (CDP)'
READY=0
for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null --max-time 2 "$CDP_URL/json/version" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 2
done
[[ "$READY" -eq 1 ]] || die "CDP no responde en $CDP_URL (¿CLOUDDESK_E2E_DEBUG=1?)."

DETECCION_RC=0
if [[ "$SKIP_DETECCION" -eq 0 ]]; then
  printf '\n%s\n' "${C_BOLD}1) Verificación de esMovil() con los valores reales del escritorio${C_RESET}"
  if ! node "$ROOT_DIR/tools/check-deteccion-clouddesk.mjs"; then
    DETECCION_RC=1
  fi
fi

printf '\n%s\n' "${C_BOLD}2) Prueba end-to-end dentro del Chromium real${C_RESET}"
E2E_ARGS=(--cdp "$CDP_URL")
[[ -n "$APP_URL" ]] && E2E_ARGS+=(--url "$APP_URL")
E2E_RC=0
node "$ROOT_DIR/tools/e2e-desktop.mjs" "${E2E_ARGS[@]}" || E2E_RC=$?

printf '\n%s\n' "${C_BOLD}3) Registro del escritorio (últimas líneas)${C_RESET}"
docker logs --tail=15 "$CONTAINER" 2>&1 | sed 's/^/  /' || true

printf '\n%s\n' "${C_BOLD}Resumen${C_RESET}"
[[ "$DETECCION_RC" -eq 0 ]] && printf '  detección : %sOK%s\n' "$C_GREEN" "$C_RESET" \
                            || printf '  detección : %sFALLO%s\n' "$C_RED" "$C_RESET"
case "$E2E_RC" in
  0) printf '  escritorio: %sPC verificado%s\n' "$C_GREEN" "$C_RESET" ;;
  2) printf '  escritorio: %sPENDIENTE%s (la app no expuso esMovil: login o URL)\n' "$C_YELLOW" "$C_RESET" ;;
  *) printf '  escritorio: %sFALLO%s\n' "$C_RED" "$C_RESET" ;;
esac

if [[ "$DETECCION_RC" -ne 0 || "$E2E_RC" -eq 1 ]]; then
  exit 1
fi
exit "$E2E_RC"
