#!/usr/bin/env bash
# =============================================================================
# CloudDesk - instalación de un solo paso en una VM Ubuntu/Debian limpia.
#
# Clona el repositorio en /opt/clouddesk y ejecuta provision-oracle.sh.
#
# Uso:
#   sudo ./scripts/install-oracle.sh --nip --yes
#   sudo ./scripts/install-oracle.sh --domain midominio.com --email tu@correo --yes
#
# O desde cero (VM recién creada):
#   curl -fsSL https://raw.githubusercontent.com/keinergarcia/Navegador/main/scripts/install-oracle.sh \
#     -o /tmp/install-oracle.sh
#   sudo bash /tmp/install-oracle.sh --nip
#
# Opciones propias:
#   --dir RUTA     Directorio destino (por defecto /opt/clouddesk).
#   --repo URL     Repositorio (por defecto el oficial de GitHub).
#   --ref REF      Rama, tag o commit (por defecto main).
#
# El resto de opciones se pasan a scripts/provision-oracle.sh (--help).
# =============================================================================
set -Eeuo pipefail

REPO_URL="https://github.com/keinergarcia/Navegador.git"
TARGET_DIR="/opt/clouddesk"
REF="main"
PASSTHROUGH=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) TARGET_DIR="${2:?}"; shift 2 ;;
    --repo) REPO_URL="${2:?}"; shift 2 ;;
    --ref) REF="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) PASSTHROUGH+=("$1"); shift ;;
  esac
done

[[ "${EUID}" -eq 0 ]] || { echo "error: ejecuta con sudo." >&2; exit 1; }
command -v git >/dev/null 2>&1 || {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq git ca-certificates curl >/dev/null
}

if [[ -d "$TARGET_DIR/.git" ]]; then
  echo "==> actualizando $TARGET_DIR ($REF)"
  git -C "$TARGET_DIR" fetch --depth 1 origin "$REF"
  git -C "$TARGET_DIR" checkout -q FETCH_HEAD
else
  echo "==> clonando $REPO_URL en $TARGET_DIR"
  mkdir -p "$(dirname "$TARGET_DIR")"
  rm -rf "$TARGET_DIR"
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$TARGET_DIR"
fi

cd "$TARGET_DIR"
exec ./scripts/provision-oracle.sh "${PASSTHROUGH[@]}"
