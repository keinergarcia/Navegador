#!/bin/bash
# Script de inicio de la sesión XFCE dentro de KasmVNC.
set -u

export HOME=/home/desk
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_RUNTIME_DIR="/tmp/runtime-desk"

mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
chmod 0700 "$XDG_RUNTIME_DIR"

# Sin salvapantallas ni ahorro de energía: la sesión la controla el agente.
xset s off -dpms >/dev/null 2>&1 || true
xsetroot -solid "#0f172a" >/dev/null 2>&1 || true

# Chromium como navegador por defecto del escritorio.
xdg-settings set default-web-browser chromium.desktop >/dev/null 2>&1 || true

unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS

# dbus-launch crea un bus de sesión aislado para este escritorio.
exec dbus-launch --exit-with-session xfce4-session
