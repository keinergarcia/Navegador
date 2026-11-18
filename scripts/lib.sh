#!/usr/bin/env bash
# =============================================================================
# CloudDesk - utilidades compartidas por los scripts.
# Se carga con: source "$(dirname "$0")/lib.sh"
# =============================================================================
if [[ -n "${CLOUDDESK_LIB_LOADED:-}" ]]; then
  return 0
fi
CLOUDDESK_LIB_LOADED=1

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_CYAN=$'\033[36m'
else
  # Se usan desde los scripts que hacen `source lib.sh`.
  # shellcheck disable=SC2034
  C_RESET="" C_BOLD="" C_DIM="" C_RED="" C_GREEN="" C_YELLOW="" C_BLUE="" C_CYAN=""
fi

log()  { printf '%s\n' "${C_BLUE}==>${C_RESET} $*"; }
step() { printf '%s\n' "${C_CYAN}  ->${C_RESET} $*"; }
ok()   { printf '%s\n' "${C_GREEN}  ok${C_RESET} $*"; }
warn() { printf '%s\n' "${C_YELLOW}aviso:${C_RESET} $*" >&2; }
die()  { printf '%s\n' "${C_RED}error:${C_RESET} $*" >&2; exit 1; }

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "falta el comando '$cmd'."
  done
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || die "este script necesita root: sudo $0 $*"
}

require_docker() {
  require_cmd docker
  docker info >/dev/null 2>&1 || die "el demonio de Docker no responde (¿está arrancado? ¿pertenece tu usuario al grupo docker?)."
  docker compose version >/dev/null 2>&1 || die "falta el plugin 'docker compose' (v2)."
}

compose() {
  docker compose --project-directory "$ROOT_DIR" -f "$COMPOSE_FILE" "$@"
}

load_env() {
  [[ -f "$ENV_FILE" ]] || die "no existe $ENV_FILE. Ejecuta scripts/bootstrap.sh primero."
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  local var
  for var in BASE_DOMAIN PANEL_HOST VNC_HOST AUTH_PASSWORD_HASH SESSION_SECRET AGENT_TOKEN VNC_PASSWORD VNC_AUTH_B64; do
    [[ -n "${!var:-}" ]] || die "la variable $var está vacía en $ENV_FILE. Revisa la configuración."
  done
}

env_get() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 1
  awk -F= -v k="$key" '$1==k {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE" | sed -e "s/^'//" -e "s/'$//"
}

# Escribe KEY='valor' en .env de forma atómica. Rechaza comillas simples y saltos
# de línea: ningún secreto generado por CloudDesk los contiene.
env_set() {
  local key="$1" value="$2"
  python3 - "$ENV_FILE" "$key" "$value" <<'PY'
import os
import sys
import tempfile

path, key, value = sys.argv[1:4]
if "'" in value or "\n" in value or "\r" in value:
    sys.exit("env_set: el valor contiene comillas simples o saltos de línea")
line = f"{key}='{value}'"
try:
    with open(path, encoding="utf-8") as fh:
        lines = fh.readlines()
except FileNotFoundError:
    lines = []
found = False
for index, current in enumerate(lines):
    if current.split("=", 1)[0] == key:
        lines[index] = line + "\n"
        found = True
        break
if not found:
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
    lines.append(line + "\n")
directory = os.path.dirname(os.path.abspath(path)) or "."
fd, tmp = tempfile.mkstemp(dir=directory, prefix=".env.", text=True)
try:
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
        fh.writelines(lines)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
PY
}

gen_hex() {
  local bytes="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    python3 -c "import secrets,sys; sys.stdout.write(secrets.token_hex(int(sys.argv[1])))" "$bytes"
  fi
}

gen_password() {
  # 24 caracteres alfanuméricos: fácil de teclear en el iPhone, 143 bits.
  python3 -c "import secrets,string,sys; a=string.ascii_letters+string.digits; sys.stdout.write(''.join(secrets.choice(a) for _ in range(24)))" 2>/dev/null \
    || openssl rand -hex 16
}

# Lee la contraseña por stdin (nunca por argv, para no exponerla en `ps`).
hash_password() {
  python3 -c '
import base64
import hashlib
import os
import sys

password = sys.stdin.buffer.read().decode("utf-8")
if len(password) < 12:
    sys.exit("la contraseña debe tener al menos 12 caracteres")
salt = os.urandom(16)
derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1,
                         dklen=32, maxmem=64 * 1024 * 1024)
b64 = lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip("=")
print(f"scrypt$16384$8$1${b64(salt)}${b64(derived)}")
'
}

confirm() {
  local prompt="$1" default="${2:-n}" answer
  if [[ ! -t 0 ]]; then
    [[ "$default" == "y" ]]
    return
  fi
  read -r -p "$prompt [$( [[ "$default" == "y" ]] && echo "S/n" || echo "s/N" )] " answer || true
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[sSyY]$ ]]
}

prompt_value() {
  local prompt="$1" default="${2:-}" answer
  if [[ -n "$default" ]]; then
    read -r -p "$prompt [$default]: " answer || true
    printf '%s' "${answer:-$default}"
  else
    read -r -p "$prompt: " answer || true
    printf '%s' "$answer"
  fi
}

validate_hostname() {
  local host="$1"
  [[ "$host" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] \
    || die "'$host' no parece un nombre de host válido (minúsculas, sin esquema ni ruta)."
}

validate_email() {
  [[ "$1" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$ ]] || die "'$1' no parece un correo válido."
}

validate_resolution() {
  [[ "$1" =~ ^[0-9]{3,4}x[0-9]{3,4}$ ]] || die "resolución inválida: usa ANCHOxALTO, por ejemplo 1366x768."
}

public_ipv4() {
  local url
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    local ip
    ip="$(curl -4 -fsS --max-time 8 "$url" 2>/dev/null | tr -d '[:space:]')" || continue
    if [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
      printf '%s' "$ip"
      return 0
    fi
  done
  return 1
}

dns_ipv4() {
  local host="$1"
  { getent ahostsv4 "$host" 2>/dev/null || true; } | awk '{print $1}' | sort -u
}

wait_http() {
  local url="$1" tries="${2:-30}"
  local i
  for ((i = 1; i <= tries; i++)); do
    if curl -fsS -o /dev/null --max-time 4 "$url" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}
