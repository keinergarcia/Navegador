#!/bin/bash
# Lanza Chromium dentro de la sesión XFCE (autostart o relanzamiento manual).
set -u

export HOME=/home/desk
export DISPLAY=:1

# Espera a que el servidor X esté listo (máx. 60 s).
for _ in $(seq 1 120); do
  if xdpyinfo -display :1 >/dev/null 2>&1; then break; fi
  sleep 0.5
done

PROFILE="$HOME/.config/chromium"
mkdir -p "$PROFILE"

# Flags deliberados:
#  - sin --no-sandbox Chromium no arranca dentro de Docker (ver docs/SEGURIDAD.md).
#  - --password-store=basic evita el diálogo de gnome-keyring en un escritorio
#    sin llavero; el perfil debe protegerse a nivel de volumen (ver docs).
#  - --enable-unsafe-swiftshader mantiene WebGL por CPU (Google Maps, etc.).
#  - NO se falsifica el User-Agent ni se altera ningún identificador.
ARGS=(
  --user-data-dir="$PROFILE"
  --no-sandbox
  --no-first-run
  --no-default-browser-check
  --password-store=basic
  --enable-unsafe-swiftshader
  --start-maximized
  --disable-session-crashed-bubble
  --hide-crash-restore-bubble
  --disable-breakpad
  --noerrdialogs
  --disable-features=TranslateUI,MediaRouter
)

# Depuración remota SOLO para la prueba end-to-end (tools/e2e-desktop.mjs).
# El puerto se escucha dentro del contenedor y únicamente se publica en
# 127.0.0.1 del host mediante docker-compose.e2e.yml. Desactivado por defecto.
if [ "${CLOUDDESK_E2E_DEBUG:-0}" = "1" ]; then
  ARGS+=(--remote-debugging-address=0.0.0.0 --remote-debugging-port=9222)
  echo "[clouddesk] CDP habilitado en :9222 (solo pruebas E2E)" >&2
fi

# shellcheck disable=SC2086
exec /usr/bin/chromium "${ARGS[@]}" ${CHROMIUM_FLAGS:-}
