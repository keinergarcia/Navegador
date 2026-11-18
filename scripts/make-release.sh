#!/usr/bin/env bash
# =============================================================================
# CloudDesk - genera el paquete de distribución (GitHub Release).
#
# Uso:
#   ./scripts/make-release.sh 1.0.0 [directorio]
#
# Crea clouddesk-<versión>.tar.gz con el contenido versionado (git archive),
# excluyendo .env, data/, backups/ y artefactos de pruebas. Genera también el
# .sha256 para verificar la descarga.
# =============================================================================
set -Eeuo pipefail

VERSION="${1:?uso: $0 <versión> [directorio]}"
OUT="${2:-dist}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NAME="clouddesk-${VERSION#v}"

command -v git >/dev/null 2>&1 || { echo "error: falta git" >&2; exit 1; }

mkdir -p "$ROOT_DIR/$OUT"

git -C "$ROOT_DIR" archive \
  --format=tar.gz \
  --prefix="$NAME/" \
  -o "$ROOT_DIR/$OUT/$NAME.tar.gz" \
  HEAD

(
  cd "$ROOT_DIR/$OUT"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256"
  else
    shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256"
  fi
)

printf 'paquete: %s/%s.tar.gz\n' "$OUT" "$NAME"
printf 'sha256 : %s\n' "$(cut -d' ' -f1 "$ROOT_DIR/$OUT/$NAME.tar.gz.sha256")"
