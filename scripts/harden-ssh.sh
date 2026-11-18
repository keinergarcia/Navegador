#!/usr/bin/env bash
# =============================================================================
# CloudDesk - endurece SSH (solo clave pública) sin romper el acceso actual.
#
# Uso:
#   sudo ./scripts/harden-ssh.sh            # aplica
#   sudo ./scripts/harden-ssh.sh --undo     # elimina la configuración
#
# Antes de ejecutarlo, comprueba en OTRA terminal que entras con clave:
#   ssh -i tu_clave ubuntu@IP
# No cierres la sesión actual hasta verificar el acceso.
# =============================================================================
source "$(dirname "$0")/lib.sh"

require_root "$@"
require_cmd sshd

DROPIN="/etc/ssh/sshd_config.d/99-clouddesk.conf"
UNDO=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --undo) UNDO=1 ;;
    --force) FORCE=1 ;;
  esac
done

reload_ssh() {
  if systemctl list-unit-files | grep -q '^ssh\.service'; then
    systemctl reload ssh
  elif systemctl list-unit-files | grep -q '^sshd\.service'; then
    systemctl reload sshd
  else
    warn 'no se encontró la unidad ssh/sshd; recarga el servicio manualmente.'
  fi
}

if [[ "$UNDO" -eq 1 ]]; then
  if [[ -f "$DROPIN" ]]; then
    rm -f "$DROPIN"
    sshd -t || die 'la configuración de sshd no es válida tras eliminar el archivo.'
    reload_ssh
    ok "eliminado $DROPIN; SSH vuelve a la configuración anterior."
  else
    ok 'no había nada que deshacer.'
  fi
  exit 0
fi

TARGET_USER="${SUDO_USER:-root}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
KEYS="$TARGET_HOME/.ssh/authorized_keys"

if [[ ! -s "$KEYS" ]]; then
  if [[ "$FORCE" -ne 1 ]]; then
    die "no hay claves públicas en $KEYS. Añade tu clave antes de desactivar contraseñas (o usa --force, NO recomendado)."
  fi
  warn "sin claves en $KEYS: se aplica igualmente por --force. ¡No cierres esta sesión!"
fi

step 'escribiendo configuración endurecida'
mkdir -p /etc/ssh/sshd_config.d
cat > "$DROPIN" <<'EOF'
# CloudDesk - gestión de acceso SSH. Elimina este archivo con:
#   sudo ./scripts/harden-ssh.sh --undo
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
MaxAuthTries 4
MaxSessions 6
LoginGraceTime 30
X11Forwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
AllowAgentForwarding no
EOF
chmod 644 "$DROPIN"

step 'validando la configuración'
sshd -t || die 'sshd -t falló: se deja la sesión actual intacta, pero revisa el archivo.'

step 'recargando sshd'
reload_ssh

EFFECTIVE="$(sshd -T 2>/dev/null | awk '$1=="passwordauthentication"{print $2}')"
[[ "$EFFECTIVE" == "no" ]] || warn "sshd -T indica passwordauthentication=$EFFECTIVE; revisa /etc/ssh/sshd_config."

ok "SSH endurecido: solo clave pública (usuario $TARGET_USER)."
printf '%s\n' "${C_YELLOW}No cierres esta sesión todavía:${C_RESET} abre otra terminal y prueba 'ssh -i tu_clave $TARGET_USER@<ip>'."
printf '%s\n' "Para revertir: sudo ./scripts/harden-ssh.sh --undo"
