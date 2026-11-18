# Despliegue en Oracle Cloud Always Free

Objetivo: una VM ARM64 gratuita con CloudDesk accesible por HTTPS, con
reinicio automático, certificado y copias de seguridad.

## 1. Crear la VM

En la consola de OCI (**Compute → Instances → Create instance**):

| Campo | Valor |
|---|---|
| Image | Ubuntu 24.04 (no Oracle Linux) |
| Shape | `VM.Standard.A1.Flex` (Always Free) |
| OCPU / RAM | 2 OCPU / 12 GB |
| Public IPv4 | Sí |
| Boot volume | 50 GB |
| SSH keys | Pega tu clave pública (`~/.ssh/id_ed25519.pub`) |

Notas:

- `Out of host capacity` es habitual en A1: reintenta en otra Availability
  Domain u otra hora.
- No uses `VM.Standard.E2.1.Micro` (1 GB): XFCE + Chromium no caben.
- El Always Free incluye hasta 4 OCPU / 24 GB en A1; 2/12 deja margen.

## 2. Abrir puertos

Dos capas:

1. **Security List / NSG** (consola): ingress TCP **80** y **443** desde
   `0.0.0.0/0`. El 22 ya suele estar.
2. **Firewall del SO**: lo hace `scripts/provision-oracle.sh` con
   `scripts/open-ports.sh` (ufw o iptables; en imágenes Oracle inserta las
   reglas antes del `REJECT` final).

## 3. DNS

Crea dos registros **A**:

```
desk.TUDOMINIO.com  → IP_PUBLICA
vnc.TUDOMINIO.com   → IP_PUBLICA
```

Si usas Cloudflare, deja ambos en **DNS only** (nube gris); el proxy rompe el
reto HTTP-01. Si no tienes dominio, usa `--nip` (ver más abajo).

## 4. Instalar

```bash
ssh ubuntu@IP
sudo apt-get update && sudo apt-get install -y git
sudo git clone https://github.com/keinergarcia/Navegador.git /opt/clouddesk
cd /opt/clouddesk

# Con dominio propio (pide la contraseña por stdin)
sudo ./scripts/install-oracle.sh --domain TUDOMINIO.com \
  --email tu@correo.com --yes

# O sin dominio:
sudo ./scripts/install-oracle.sh --nip --yes
```

`install-oracle.sh` clona/actualiza `/opt/clouddesk` y ejecuta
`provision-oracle.sh`, que:

1. Instala dependencias y Docker Engine + compose v2.
2. Abre 80/443 en el firewall del SO.
3. Genera `.env` con secretos aleatorios (o conserva los existentes).
4. Construye y arranca el stack (`bootstrap.sh --start`).
5. Espera a `https://PANEL/healthz` (autofirmado).
6. Espera al DNS y emite el certificado de Let's Encrypt.
7. Instala y habilita `clouddesk.service`, `clouddesk-renew.timer` y
   `clouddesk-backup.timer`.
8. Ejecuta la prueba de humo con la contraseña indicada.

Duración: 10–25 minutos (el build en ARM es la mayor parte).

### Contraseña sin interacción

```bash
printf '%s\n' 'TU_CONTRASEÑA_DE_16+' | sudo ./scripts/install-oracle.sh \
  --domain TUDOMINIO.com --email tu@correo.com --password-stdin --yes
```

Si no la indicas, se genera una y se imprime **una sola vez** al final.

### Sin dominio (`nip.io`)

```bash
sudo ./scripts/install-oracle.sh --nip --yes
```

Usa `desk.<IP>.nip.io` y `vnc.<IP>.nip.io`. Funciona, pero Let's Encrypt
comparte cuota entre todos los usuarios de `nip.io`: para producción, dominio
propio. Para pruebas, `./scripts/issue-cert.sh --staging`.

## 5. Comprobar

```bash
cd /opt/clouddesk
./scripts/smoke-test.sh --password-stdin   # pide la contraseña
docker compose ps                           # solo edge publica 80/443
systemctl status clouddesk.service --no-pager
```

Esperado:

- `https://desk.TUDOMINIO` → panel con login.
- `https://vnc.TUDOMINIO` sin sesión → 302 al panel.
- Dentro del panel, el escritorio carga en el iframe.

Si el certificado aún no se emitió:

```bash
./scripts/issue-cert.sh          # requiere DNS propagado y puerto 80 abierto
```

## 6. Operación

| Tarea | Comando |
|---|---|
| Actualizar | `./scripts/update.sh` |
| Actualizar también el SO | `sudo ./scripts/update.sh --with-apt` |
| Copia de seguridad | `./scripts/backup.sh` |
| Restaurar | `./scripts/restore.sh backups/clouddesk-....tar.gz` |
| Cambiar contraseña | `./scripts/set-password.sh` |
| Renovar certificado | `./scripts/renew-cert.sh` (timer automático) |
| Ver logs | `docker compose logs -f --tail=100` |
| Parar | `docker compose down` |

Los timers de systemd (`clouddesk-renew.timer`, `clouddesk-backup.timer`) se
activan durante el aprovisionamiento.

## 7. Despliegue con imágenes de GHCR (sin compilar en la VM)

En un equipo con Docker, tras publicar un Release:

```bash
CLOUDDESK_VERSION=1.0.0 docker compose -f docker-compose.yml \
  -f docker-compose.prod.yml up -d --no-build --pull always
```

En la VM, lo mismo con `sudo docker compose ...`. Si el paquete de GHCR es
privado:

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u TU_USUARIO --password-stdin
```

Esto ahorra CPU y disco en la VM (el build de XFCE + Chromium es lo más pesado).

## 8. Seguridad y coste

- El Always Free no cobra la VM A1 dentro de los límites; vigila el correo de
  OCI por si cambias de shape o añades volúmenes.
- Restringe SSH a tu IP si es posible y usa solo claves:
  `sudo ./scripts/harden-ssh.sh`.
- No publiques 8444/8099: el compose no lo hace y `open-ports.sh` solo abre
  80/443.
- Revisa [SEGURIDAD.md](SEGURIDAD.md) antes de exponer el servicio.

## 9. Problemas frecuentes

| Síntoma | Causa / solución |
|---|---|
| `Out of host capacity` | Otra Availability Domain u otra hora |
| `docker: permission denied` | `newgrp docker` o reabrir sesión SSH |
| El panel no carga tras el build | `docker compose logs -f --tail=100` |
| Certificado falla | DNS sin propagar, Cloudflare en proxy o 80 cerrado |
| Cookie no persiste | `COOKIE_DOMAIN=.TUDOMINIO` y hosts bajo el mismo dominio |
| 503 en el iframe | Sesión arrancando; el agente la inicia al entrar |
| Se agota el disco | `docker system prune -af --volumes` (¡revisa antes!) |
