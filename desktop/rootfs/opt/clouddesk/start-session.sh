#!/bin/bash
# Arranca una sesión KasmVNC en primer plano (supervisado por supervisord).
set -euo pipefail

export HOME=/home/desk
export DISPLAY=:1
mkdir -p "$HOME/.vnc" "$HOME/.clouddesk"

# KasmVNC 1.5.2 lanza un selector interactivo de entorno de escritorio si no
# existe este marcador ("Please choose Desktop Environment to run"). Nosotros
# usamos siempre nuestro xstartup, así que marcamos la elección como hecha.
touch "$HOME/.vnc/.de-was-selected"

# Renderiza ~/.vnc/kasmvnc.yaml y devuelve la geometría efectiva.
GEOMETRY="$(python3 /opt/clouddesk/render-config.py)"

# Limpia restos de un cierre no limpio (solo si no hay servidor X vivo).
if ! pgrep -x Xkasmvnc >/dev/null 2>&1; then
  rm -f /tmp/.X1-lock "/tmp/.X11-unix/X1" "$HOME/.vnc/"*.pid 2>/dev/null || true
fi

exec /usr/bin/kasmvncserver :1 -fg \
  -geometry "$GEOMETRY" \
  -depth 24 \
  -interface 0.0.0.0 \
  -websocketPort 8444 \
  -httpd /usr/share/kasmvnc/www \
  -config "$HOME/.vnc/kasmvnc.yaml" \
  -xstartup /opt/clouddesk/xstartup.sh \
  -prompt 0
