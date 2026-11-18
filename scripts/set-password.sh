#!/usr/bin/env bash
# =============================================================================
# CloudDesk - cambia la contraseña del panel.
#
# Uso:
#   ./scripts/set-password.sh                  (pregunta dos veces)
#   ./scripts/set-password.sh --generate       (genera una y la muestra)
#   printf '%s\n' 'nueva-contraseña' | ./scripts/set-password.sh --password-stdin
#
# Opciones:
#   --password-stdin   Lee la contraseña de stdin (una línea).
#   --generate         Genera una contraseña aleatoria de 24 caracteres.
#   --keep-sessions    No rota SESSION_SECRET (por defecto se cierran todas
#                      las sesiones abiertas, lo recomendable tras cambiarla).
#   --no-restart       Solo actualiza .env; no recrea el contenedor api.
# =============================================================================
source "$(dirname "$0")/lib.sh"

PASSWORD_STDIN=0
GENERATE=0
ROTATE=1
RESTART=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --password-stdin) PASSWORD_STDIN=1; shift ;;
    --generate) GENERATE=1; shift ;;
    --keep-sessions) ROTATE=0; shift ;;
    --no-restart) RESTART=0; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "opción desconocida: $1" ;;
  esac
done

require_cmd python3 openssl
load_env

PASSWORD=""
if [[ "$GENERATE" -eq 1 ]]; then
  PASSWORD="$(gen_password)"
elif [[ "$PASSWORD_STDIN" -eq 1 ]]; then
  IFS= read -r PASSWORD || true
  [[ -n "$PASSWORD" ]] || die "no se recibió ninguna contraseña por stdin."
elif [[ -t 0 ]]; then
  while true; do
    read -r -s -p 'Nueva contraseña (mín. 12 caracteres): ' PASSWORD || true
    printf '\n'
    [[ ${#PASSWORD} -ge 12 ]] || { warn "demasiado corta."; continue; }
    repeated=""
    read -r -s -p 'Repite la contraseña: ' repeated || true
    printf '\n'
    [[ "$PASSWORD" == "$repeated" ]] && break
    warn "no coinciden."
  done
  unset repeated
else
  die "sin TTY: usa --generate o --password-stdin."
fi
[[ ${#PASSWORD} -ge 12 ]] || die "la contraseña debe tener al menos 12 caracteres."

log 'actualizando el hash en .env'
HASH="$(printf '%s' "$PASSWORD" | hash_password)"
env_set AUTH_PASSWORD_HASH "$HASH"
ok 'contraseña actualizada (scrypt N=16384, r=8, p=1)'

if [[ "$ROTATE" -eq 1 ]]; then
  env_set SESSION_SECRET "$(gen_hex 32)"
  ok 'SESSION_SECRET rotado: todas las sesiones anteriores quedan invalidadas'
fi

if [[ "$GENERATE" -eq 1 ]]; then
  printf '\n%s\n' "${C_YELLOW}Nueva contraseña (guárdala ahora):${C_RESET} ${C_BOLD}$PASSWORD${C_RESET}"
fi

if [[ "$RESTART" -eq 1 ]] && docker info >/dev/null 2>&1; then
  if compose ps --status running --services 2>/dev/null | grep -qx api; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
    log 'recreando el contenedor api para aplicar el cambio'
    compose up -d api
    ok 'api recreado (verifica con ./scripts/smoke-test.sh)'
  else
    warn 'el contenedor api no está en marcha; el cambio se aplicará al arrancarlo.'
  fi
fi

printf '\n%s\n' "Entra en ${C_BOLD}https://$PANEL_HOST${C_RESET} con la nueva contraseña."
