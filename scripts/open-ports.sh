#!/usr/bin/env bash
# =============================================================================
# CloudDesk - abre los puertos 80 y 443 en el firewall del host.
#
# Oracle Cloud aplica DOS capas de firewall:
#   1. Security List / NSG de la VCN (consola web de OCI). No se puede cambiar
#      desde aquí: añade reglas de entrada TCP 80 y 443 desde 0.0.0.0/0.
#   2. Firewall del sistema operativo (este script).
#
# Uso: sudo ./scripts/open-ports.sh
# =============================================================================
source "$(dirname "$0")/lib.sh"

require_root "$@"

PORTS=(80 443)
CHANGED=0

log 'abriendo puertos 80/tcp y 443/tcp'

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  step 'ufw está activo: se usan reglas de ufw'
  for port in "${PORTS[@]}"; do
    if ufw status | grep -Eq "^$port/tcp\s+ALLOW"; then
      ok "ufw: $port/tcp ya permitido"
    else
      ufw allow "$port/tcp" comment 'CloudDesk' >/dev/null
      ok "ufw: $port/tcp permitido"
      CHANGED=1
    fi
  done
else
  step 'ufw inactivo: se usan reglas de iptables'
  require_cmd iptables

  for port in "${PORTS[@]}"; do
    if iptables -w 5 -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
      ok "iptables: $port/tcp ya permitido"
    else
      iptables -w 5 -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
      ok "iptables: $port/tcp permitido"
      CHANGED=1
    fi
    if command -v ip6tables >/dev/null 2>&1; then
      if ! ip6tables -w 5 -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
        ip6tables -w 5 -I INPUT 1 -p tcp --dport "$port" -j ACCEPT 2>/dev/null || true
      fi
    fi
  done

  if [[ "$CHANGED" -eq 1 ]]; then
    step 'guardando reglas para que sobrevivan al reinicio'
    if command -v netfilter-persistent >/dev/null 2>&1; then
      netfilter-persistent save >/dev/null && ok 'reglas guardadas con netfilter-persistent'
    elif [[ -d /etc/iptables ]]; then
      iptables-save > /etc/iptables/rules.v4
      command -v ip6tables-save >/dev/null 2>&1 && ip6tables-save > /etc/iptables/rules.v6 || true
      ok 'reglas guardadas en /etc/iptables/'
    else
      warn 'no hay netfilter-persistent ni /etc/iptables; las reglas se perderán al reiniciar.'
      warn 'Instala iptables-persistent: sudo apt install iptables-persistent'
    fi
  fi

  # Las imágenes de Oracle suelen terminar INPUT con una regla REJECT.
  if iptables -w 5 -S INPUT 2>/dev/null | grep -q '^-A INPUT -j REJECT'; then
    ok 'detectada la regla REJECT de Oracle: las reglas ACCEPT se insertaron antes.'
  fi
fi

printf '\n'
printf '%s\n' "${C_YELLOW}${C_BOLD}Falta la capa de OCI (obligatoria):${C_RESET}"
printf '%s\n' "  Consola OCI -> Networking -> Virtual Cloud Networks -> tu VCN"
printf '%s\n' "  -> Security Lists -> Default Security List -> Add Ingress Rules:"
printf '%s\n' "     Source 0.0.0.0/0 · IP Protocol TCP · Destination Port Range 80"
printf '%s\n' "     Source 0.0.0.0/0 · IP Protocol TCP · Destination Port Range 443"
printf '%s\n' "  (Si usas NSG, añádelas al NSG de la instancia)."
printf '\n'
printf '%s\n' "Comprueba desde fuera: curl -I http://$(env_get PANEL_HOST || echo TU_DOMINIO)/"
