# CloudDesk

Escritorio Linux real (XFCE + Chromium + KasmVNC) servido por HTTPS en el navegador.
Pensado para ejecutar aplicaciones web que solo admiten PC de escritorio sin
falsificar el navegador: dentro de CloudDesk hay un Chromium auténtico sobre X11,
con ratón, sin pantalla táctil y con resolución de escritorio (1366×768 por
defecto).

- **Repositorio**: <https://github.com/keinergarcia/Navegador>
- **Licencia**: MIT
- **Arquitectura objetivo**: Oracle Cloud Always Free · Ubuntu 24.04 · ARM64
  (`VM.Standard.A1.Flex`, 2 OCPU / 12 GB) · Docker Engine + Compose v2.
- **Alternativa sin coste y sin dominio**: GitHub Codespaces
  (ver [docs/CODESPACES.md](docs/CODESPACES.md)).

## Estado

| Comprobación | Estado |
|---|---|
| Pruebas del API (`npm test`, 16 casos) | ✅ ejecutadas |
| Auditoría del repositorio (`tools/repo-audit.mjs`) | ✅ ejecutada |
| Autoprueba de la herramienta E2E (`--selftest`) | ✅ ejecutada con Chrome real |
| Detección `esMovil()` (13 casos) | ✅ 13/13 PASS |
| Build Docker amd64/ARM64 | ⏳ validado en CI (no hay Docker en el equipo de desarrollo) |
| Despliegue Oracle / Codespaces | ⏳ pendiente de servidor o de sesión de GitHub |

El detalle de la auditoría está en [docs/AUDITORIA.md](docs/AUDITORIA.md).

## Arquitectura

```
                 Internet
                    │  HTTPS 443
            ┌───────▼────────┐
            │  edge (nginx)  │  TLS, panel estático, proxy, rate limit
            └───┬────────┬───┘
       panel    │        │  iframe + WebSocket
   desk.dominio │        │  vnc.dominio
        ┌───────▼──┐  ┌──▼──────────────┐
        │   api    │  │ desktop         │
        │ Node 24  │─▶│ XFCE + Chromium │
        │ auth/CSRF│  │ KasmVNC :8444   │
        └──────────┘  │ agent  :8099    │
                      └─────────────────┘
```

| Servicio | Imagen | Puerto interno | Publicado |
|---|---|---|---|
| `edge` | nginx alpine | 80, 443 | **sí** |
| `api` | Node 24 slim | 8080 | no |
| `desktop` | Debian 13 + XFCE + Chromium + KasmVNC | 8444, 8099 | no |

Solo se publican 80/443. KasmVNC nunca se expone directamente: nginx valida la
cookie de sesión (`auth_request`) e inyecta las credenciales Basic hacia
KasmVNC, de modo que el navegador no las conoce.

### Por qué la detección es real

`desktop/rootfs/opt/clouddesk/launch-chromium.sh` no pasa `--user-agent` ni
flags táctiles. El contenedor no tiene pantalla táctil y KasmVNC entrega eventos
de ratón reales, por lo que el navegador reporta:

- `navigator.maxTouchPoints === 0`
- `matchMedia("(pointer: coarse)") === false`
- `matchMedia("(any-pointer: fine)") === true`
- UA de Linux de escritorio y pantalla 1366×768 (o la configurada)

No se suplanta ningún dispositivo: es un PC Linux auténtico, solo que remoto.

## Requisitos

- VM/servidor con Ubuntu 24.04 o Debian 13 (ARM64 o x86_64), 2 vCPU y 4–8 GB.
- Docker Engine 24+ con el plugin `docker compose` v2.
- Dominio propio (recomendado) **o** conexión a Internet para usar
  `<IP>.nip.io`.
- Puertos 80 y 443 abiertos en el firewall del proveedor.
- Cuenta de GitHub para CI/CD y Codespaces.

## Inicio rápido

### A. GitHub Codespaces (gratis, sin dominio)

1. En GitHub: **Code → Codespaces → Create codespace on main**.
2. Espera al `postCreate` y comprueba Docker:
   ```bash
   ./scripts/codespaces-up.sh --check-only
   ```
3. Construye y arranca el escritorio (10–20 min la primera vez):
   ```bash
   ./scripts/codespaces-up.sh
   ```
4. Abre el puerto **8444** (pestaña *Ports*; visibilidad privada) y entra con
   usuario `desk` y la contraseña que imprime el script.
5. Ejecuta las pruebas reales:
   ```bash
   ./scripts/codespaces-e2e.sh
   ```

Detalles, límites del plan gratuito y solución de problemas:
[docs/CODESPACES.md](docs/CODESPACES.md).

### B. Oracle Cloud Always Free (producción)

En la VM, como `root`:

```bash
sudo apt-get update && sudo apt-get install -y git
sudo git clone https://github.com/keinergarcia/Navegador.git /opt/clouddesk
cd /opt/clouddesk
sudo ./scripts/install-oracle.sh --domain midominio.com --email tu@correo.com --yes
# o sin dominio propio:
sudo ./scripts/install-oracle.sh --nip --yes
```

El script instala Docker, abre puertos, genera secretos, arranca el stack,
espera al DNS, emite el certificado y configura systemd. Guía completa:
[docs/DESPLIEGUE-ORACLE.md](docs/DESPLIEGUE-ORACLE.md).

### C. Local (Linux con Docker)

```bash
git clone https://github.com/keinergarcia/Navegador.git
cd Navegador
sudo ./scripts/bootstrap.sh --domain midominio.local --password-stdin --start
```

Para desarrollo sin Docker (panel + agente simulado):

```bash
./scripts/dev-local.sh        # http://127.0.0.1:8088
```

## Configuración

`scripts/bootstrap.sh` genera `.env` (modo 600) con secretos aleatorios. Nunca
se versiona. Variables principales:

| Variable | Uso |
|---|---|
| `BASE_DOMAIN`, `PANEL_HOST`, `VNC_HOST` | Dominios del panel y del escritorio |
| `COOKIE_DOMAIN` | Dominio de la cookie (`.midominio.com`) |
| `AUTH_PASSWORD_HASH` | Hash scrypt de la contraseña del panel |
| `SESSION_SECRET` | Firma HMAC de la sesión |
| `AGENT_TOKEN` | Token API ↔ agente del escritorio |
| `VNC_USER`, `VNC_PASSWORD`, `VNC_AUTH_B64` | Credenciales internas de KasmVNC |
| `RESOLUTION` | Resolución virtual (`1366x768`) |
| `IDLE_STOP_MINUTES` | Suspensión por inactividad (0 = nunca) |
| `DESKTOP_CPUS`, `DESKTOP_MEM_LIMIT`, `SHM_SIZE` | Límites del contenedor |

Cambiar la contraseña del panel:

```bash
./scripts/set-password.sh
```

## Dominio y HTTPS

- Crea registros **A** para `desk.DOMINIO` y `vnc.DOMINIO` apuntando a la IP
  pública.
- Emite el certificado cuando el DNS propague:
  ```bash
  ./scripts/issue-cert.sh
  ```
- Si usas Cloudflare, los dos registros deben estar en **DNS only** (nube gris).
- Sin dominio propio, `--nip` usa `<IP>.nip.io`. Es válido para pruebas, pero
  Let's Encrypt comparte cuota entre todos los usuarios de `nip.io`; para
  producción usa un dominio real.
- Renovación automática: `clouddesk-renew.timer` (systemd) o cron.

## GitHub Actions

| Workflow | Cuándo | Qué hace |
|---|---|---|
| `ci.yml` | push, PR, manual | Sintaxis, ShellCheck, YAML, `docker compose config`, tests del API, auditoría, autoprueba E2E y build nativo amd64 + arm64 |
| `release.yml` | tags `v*`, manual | Publica imágenes multi-arquitectura en GHCR y crea el Release con el `.tar.gz` |
| `deploy.yml` | manual, tag, main con `AUTO_DEPLOY=true` | Despliegue por SSH y prueba de humo |

Secrets necesarios para desplegar:

| Secret / variable | Contenido |
|---|---|
| `DEPLOY_HOST` | IP o host del servidor |
| `DEPLOY_USER` | Usuario SSH (por defecto `ubuntu`) |
| `DEPLOY_SSH_KEY` | Clave privada ed25519 |
| `DEPLOY_KNOWN_HOSTS` | Salida de `ssh-keyscan` del servidor |
| `CLOUDDESK_PASSWORD` | Contraseña del panel (opcional, para el smoke test) |
| `DEPLOY_PATH` (variable) | Ruta del proyecto (por defecto `/opt/clouddesk`) |
| `AUTO_DEPLOY` (variable) | `true` para desplegar en cada push a `main` |

Guía detallada: [docs/CI-CD.md](docs/CI-CD.md).

## Actualización, copias y restauración

```bash
./scripts/update.sh              # git pull + rebuild + smoke test
./scripts/update.sh --with-apt   # además actualiza el sistema
./scripts/backup.sh              # .env + certificados + perfil del escritorio
./scripts/restore.sh backups/clouddesk-....tar.gz
```

Con imágenes publicadas (sin compilar en la VM):

```bash
CLOUDDESK_VERSION=1.0.0 docker compose -f docker-compose.yml \
  -f docker-compose.prod.yml up -d --no-build --pull always
```

## Pruebas

```bash
cd api && npm test                    # 16 pruebas unitarias/de integración
node tools/repo-audit.mjs             # auditoría estática del repositorio
node tools/e2e-desktop.mjs --selftest # valida la herramienta E2E con Chrome real
node tools/check-deteccion-clouddesk.mjs  # 13 casos de esMovil()
./scripts/smoke-test.sh --password-stdin  # despliegue real
./scripts/codespaces-e2e.sh               # escritorio real en Codespaces
```

La prueba E2E abre la app dentro del Chromium del escritorio, lee las señales
reales del navegador y ejecuta `esMovil()` del propio despliegue. No simula
dispositivos ni modifica la lógica de detección. Ver
[docs/PRUEBA-E2E.md](docs/PRUEBA-E2E.md).

## Seguridad

Resumen: contraseña única con scrypt, cookie `HttpOnly`/`Secure`/`SameSite=Lax`
firmada con HMAC, CSRF con token + `Origin`, rate limit en nginx y en el API,
TLS 1.2/1.3, HSTS, CSP, KasmVNC sin exponer, contenedores sin privilegios,
`no-new-privileges`, `cap_drop: ALL` en el API y socket de Docker fuera de los
contenedores. Detalle y riesgos aceptados: [docs/SEGURIDAD.md](docs/SEGURIDAD.md).

## Solución de problemas

| Síntoma | Causa / solución |
|---|---|
| `permission denied` al usar Docker | `newgrp docker` o cierra y reabre la sesión SSH |
| OCI: `Out of host capacity` | Prueba otra Availability Domain u otra hora; no afecta al plan gratuito |
| El panel no guarda la sesión | `COOKIE_DOMAIN` debe ser `.DOMINIO` y ambos hosts deben estar bajo él |
| `issue-cert.sh` falla | DNS aún no propaga, Cloudflare en modo proxy o puerto 80 cerrado |
| `503` en el iframe | La sesión está arrancando; `docker compose logs -f desktop` |
| Chromium no arranca | Falta `shm_size` (1 GB) o la sesión no tiene X: revisa los logs |
| La app sigue diciendo "Solo desde PC" | Comprueba que entras por el escritorio (`vnc.DOMINIO`), no desde el móvil |
| Codespaces: Docker no responde | Espera al `postCreate` o reinicia el contenedor de desarrollo |
| E2E sale con código 2 | La app exige login: inicia sesión en Chromium y repite, o pasa `--url` |

## Estructura

```
api/            API de autenticación y control (Node, sin dependencias)
gateway/        nginx: TLS, panel estático, proxy a KasmVNC
desktop/        Imagen Debian: XFCE, Chromium, KasmVNC, agente
scripts/        bootstrap, install/provision, certificados, backup, smoke
deploy/         unidades systemd
tools/          auditoría, verificación de detección y E2E
tests/          fixtures y artefactos (ignorados)
docs/           auditoría, Oracle, CI/CD, seguridad, E2E, Codespaces
```

## Licencia

MIT. Ver [LICENSE](LICENSE).
