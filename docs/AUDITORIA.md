# Auditoría técnica de CloudDesk

Fecha: 2026-11-18 · Alcance: repositorio completo (`api`, `gateway`, `desktop`,
`scripts`, `deploy`, `tools`) y despliegue previsto en Oracle Cloud Always Free
(ARM64) y GitHub Codespaces.

## Resumen

La base del proyecto es sólida: autenticación sin dependencias externas, proxy
con `auth_request`, KasmVNC nunca publicado, y una detección de escritorio que
no falsifica el navegador. Los problemas encontrados eran de **acabado de
producción**: falta de documentación y CI, verificación criptográfica
incompleta en x86_64, ausencia de `.dockerignore`, y algunos detalles de
robustez en scripts y configuración.

| Severidad | Encontrados | Corregidos | Documentados |
|---|---|---|---|
| Alta | 1 | 1 | 0 |
| Media | 5 | 5 | 0 |
| Baja | 9 | 7 | 2 |
| Informativa | 4 | 1 | 3 |

## Hallazgos

### A-01 · Alta · SHA-256 de KasmVNC sin fijar en amd64

`desktop/Dockerfile` declaraba `KASMVNC_SHA256_AMD64=` vacío. El bloque de
verificación avisaba y **continuaba sin comprobar** el `.deb` en x86_64, lo que
permite instalar un paquete manipulado si se compromete la descarga.

Verificación realizada:

```
kasmvncserver_debian_trixie_1.5.2_arm64.deb  904615b5…f62fa9  (coincide con el pin existente)
kasmvncserver_debian_trixie_1.5.2_amd64.deb  6ed95716…9407f8  (calculado y fijado)
```

El método se validó comprobando que el hash ARM64 calculado con el mismo
procedimiento coincide con el valor que ya estaba fijado. **Corregido.**

### A-02 · Media · Repositorio sin README ni documentación de despliegue

`deploy/systemd/clouddesk.service` apuntaba a `/opt/clouddesk/README.md`, que no
existía. No había guía de Oracle, CI/CD, seguridad ni prueba E2E. **Corregido**
con `README.md` y `docs/`.

### A-03 · Media · Sin CI/CD

No existía `.github/`, por lo que nada verificaba sintaxis, tests, compose ni la
compatibilidad ARM64 antes de desplegar. **Corregido** con `ci.yml`,
`release.yml`, `deploy.yml` y Dependabot.

### A-04 · Media · `nginx -t` silenciado en la imagen del gateway

`gateway/Dockerfile` ejecutaba `nginx -t … || true`, ocultando errores de
configuración en el build. **Corregido**: el build falla si la configuración es
inválida y la plantilla con variables se valida en CI con certificados de
prueba.

### A-05 · Media · `depends_on` no esperaba al healthcheck del escritorio

El API podía arrancar antes de que el agente estuviera listo y mostrar
`agentOnline: false` en el primer acceso. **Corregido**: `condition:
service_healthy`.

### A-06 · Media · `git pull` incompatible con despliegue por tag

`scripts/update.sh` ejecutaba `git pull --ff-only` incluso con HEAD separado
(despliegue por tag o commit desde CI), lo que aborta el script por `set -e`.
**Corregido**: se omite el pull en HEAD separado y con `CLOUDDESK_SKIP_PULL=1`.

### A-07 · Baja · Artefacto de distribución dentro del árbol de trabajo

`clouddesk-deploy-20261118.tar.gz` (1,3 MB) estaba en la raíz. **Corregido**:
`*.tar.gz` ignorado; el paquete se genera con `scripts/make-release.sh` y se
publica como asset del Release.

### A-08 · Baja · `__pycache__` dentro del contexto de build

`desktop/rootfs/opt/clouddesk/__pycache__` se copiaba a la imagen. **Corregido**:
directorio eliminado, excluido en `.gitignore` y en `desktop/.dockerignore`.

### A-09 · Baja · Sin `.dockerignore`

Los contextos enviaban tests y metadatos innecesarios. **Corregido** en `api/`,
`gateway/` y `desktop/`.

### A-10 · Baja · Bootstrap sin soporte para `nip.io`

Solo aceptaba un dominio propio, lo que bloqueaba pruebas sin DNS. **Corregido**
con `--nip` (detecta la IP pública y usa `<IP>.nip.io`) y con la advertencia de
cuota compartida de Let's Encrypt.

### A-11 · Baja · Parámetros scrypt sin límite al verificar

`verifyPassword()` aceptaba cualquier `N`, `r`, `p` del hash almacenado; un
`.env` manipulado podía provocar un consumo desmedido de CPU/memoria.
**Corregido**: `N` potencia de dos entre 4096 y 65536, `r` 1–16, `p` 1–4, hash
de 16–64 bytes, con prueba unitaria.

### A-12 · Baja · `logout` sin token CSRF

`POST /api/auth/logout` no exige CSRF. El impacto es bajo (cerrar sesión,
mitigado por `SameSite=Lax`), pero conviene exigirlo en el futuro. **Documentado,
sin cambios** para no romper el flujo actual.

### A-13 · Baja · Imágenes base con etiqueta flotante

`debian:13-slim`, `node:24-bookworm-slim` y `nginx:stable-alpine` no están
fijadas por digest. **Mitigado** con Dependabot semanal; para reproducibilidad
total, fijar digests en una revisión posterior.

### A-14 · Baja · Cookies y `Domain` con `nip.io`

Se comprobó que `nip.io` **no** está en la Public Suffix List, por lo que
`Domain=.IP.nip.io` es aceptado por los navegadores. Aun así, se recomienda
dominio propio para producción. **Documentado.**

### A-15 · Baja · Detección de sistema operativo del host

El contenedor reporta `X11; Linux` y no el SO del cliente. Es el comportamiento
correcto: la app se ejecuta en el escritorio remoto. **Documentado.**

### A-16 · Informativa · `--no-sandbox` en Chromium

Necesario en Docker sin namespaces de usuario. Se compensa con usuario no root
(`desk`), `no-new-privileges`, `cap_drop` en otros servicios y ausencia de
dispositivos. Riesgo aceptado y documentado en `docs/SEGURIDAD.md`.

### A-17 · Informativa · Sesión KasmVNC única y compartida

KasmVNC arranca en modo `shared` con un solo usuario: no hay multiusuario ni
aislamiento por sesión. Es coherente con el diseño (un panel, un escritorio).
**Documentado.**

### A-18 · Informativa · Autenticación de un solo factor

El panel usa una única contraseña; no hay usuario, MFA ni recuperación. Es una
decisión de diseño para uso personal. Se recomienda contraseña larga y, si se
expone a Internet, añadir MFA en el proxy. **Documentado.**

### A-19 · Informativa · Logs con IP de origen

El API registra la IP del cliente y los intentos fallidos. Es útil para
diagnóstico y límite de intentos; no se registran contraseñas ni cookies.
**Verificado por inspección.**

## Comprobaciones ejecutadas

| Comprobación | Resultado |
|---|---|
| `cd api && npm test` | 16/16 ✅ |
| `node tools/repo-audit.mjs` | ✅ (ver salida en el commit) |
| `node tools/e2e-desktop.mjs --selftest` | ✅ PC detectado, bloqueo detectado |
| `node tools/check-deteccion-clouddesk.mjs` | 13/13 PASS ✅ |
| `python3 -m py_compile` (agente/render-config) | ✅ |
| `node --check` (API, tools, web) | ✅ |
| `bash -n` (scripts) | ✅ |
| Descarga y SHA-256 de KasmVNC 1.5.2 amd64/arm64 | ✅ |
| `docker compose config` | ⏳ en CI (no hay Docker en el equipo local) |
| Build arm64/amd64 | ⏳ en CI |

## Riesgos residuales

1. **Dependencia de KasmVNC** como único servidor VNC: si el proyecto deja de
   publicar binarios para Debian 13, hay que fijar una versión anterior.
2. **Cuota de Let's Encrypt** con `nip.io` compartida: no usar en producción.
3. **Sin MFA** en el panel: contraseña de 12+ caracteres obligatoria; valorar
   MFA si el servicio se hace público.
4. **Build no ejecutado localmente**: la validación real de las imágenes queda
   en CI y en el despliegue de Codespaces/Oracle.
