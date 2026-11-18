#!/bin/bash
# Entrypoint del contenedor del escritorio. Se ejecuta como root y prepara
# el estado persistente antes de ceder el control a supervisord.
set -euo pipefail

: "${AGENT_TOKEN:?AGENT_TOKEN no definido}"
: "${VNC_PASSWORD:?VNC_PASSWORD no definido}"

VNC_USER="${VNC_USER:-desk}"
RESOLUTION="${RESOLUTION:-1366x768}"
STATE_DIR=/home/desk/.clouddesk

case "$AGENT_TOKEN" in
  *[!0-9a-fA-F]*|"") echo "AGENT_TOKEN inválido (se espera hex)" >&2; exit 1 ;;
esac
if [ "${#AGENT_TOKEN}" -lt 32 ]; then
  echo "AGENT_TOKEN demasiado corto (mínimo 32 caracteres hex)" >&2
  exit 1
fi
if [ "${#VNC_PASSWORD}" -lt 12 ]; then
  echo "VNC_PASSWORD demasiado corto (mínimo 12 caracteres)" >&2
  exit 1
fi

mkdir -p "$STATE_DIR" /home/desk/.vnc /var/log/clouddesk
chown -R desk:desk /home/desk/.vnc "$STATE_DIR" /var/log/clouddesk 2>/dev/null || true

# --- Credenciales de KasmVNC -------------------------------------------------
# KasmVNC exige al menos un usuario con permiso de escritura aunque la
# autenticación la termine nginx. La contraseña se pasa por archivo temporal
# para no interpolarla en una línea de comandos.
if ! command -v kasmvncpasswd >/dev/null 2>&1; then
  echo "kasmvncpasswd no encontrado: la instalación de KasmVNC falló" >&2
  exit 1
fi
PW_TMP="$(mktemp /tmp/vncpass.XXXXXX)"
printf '%s\n%s\n' "$VNC_PASSWORD" "$VNC_PASSWORD" > "$PW_TMP"
chown desk:desk "$PW_TMP"
chmod 0600 "$PW_TMP"
if ! runuser -u desk -- /bin/bash -c \
     'kasmvncpasswd -u "$1" -w /home/desk/.kasmpasswd < "$2"' _ "$VNC_USER" "$PW_TMP"; then
  rm -f "$PW_TMP"
  echo "No se pudo crear /home/desk/.kasmpasswd" >&2
  exit 1
fi
rm -f "$PW_TMP"
chmod 0600 /home/desk/.kasmpasswd
chown desk:desk /home/desk/.kasmpasswd

# --- Resolución persistida ---------------------------------------------------
if [ ! -s "$STATE_DIR/resolution.json" ]; then
  python3 - "$RESOLUTION" <<'PY'
import json, re, sys, os
raw = sys.argv[1].strip().lower()
m = re.fullmatch(r"(\d{3,4})x(\d{3,4})", raw)
if not m:
    sys.exit(f"RESOLUTION inválida: {raw}")
w, h = int(m.group(1)), int(m.group(2))
path = "/home/desk/.clouddesk/resolution.json"
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump({"width": w, "height": h}, fh)
os.replace(tmp, path)
PY
fi
chown -R desk:desk "$STATE_DIR"
chmod 0750 "$STATE_DIR"

# --- Permisos del volumen persistente ---------------------------------------
# Solo los directorios de primer nivel: recorrer un perfil de Chromium grande
# en cada arranque retrasa el inicio varios segundos.
for d in /home/desk/* /home/desk/.[!.]*; do
  [ -e "$d" ] || continue
  chown desk:desk "$d" 2>/dev/null || true
done

echo "[clouddesk] iniciando supervisord (usuario $(id -un), resolución $(cat "$STATE_DIR/resolution.json"))"
exec "$@"
