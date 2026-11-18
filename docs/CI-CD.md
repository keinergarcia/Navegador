# CI/CD con GitHub Actions

## Workflows

| Archivo | Disparadores | Contenido |
|---|---|---|
| `.github/workflows/ci.yml` | push a `main`, PR, manual, tags | Sintaxis, ShellCheck, YAML, `docker compose config`, tests, auditoría, autoprueba E2E, build nativo amd64/arm64 |
| `.github/workflows/release.yml` | tags `v*`, manual con versión | Imágenes multi-arquitectura en GHCR + Release con `.tar.gz` |
| `.github/workflows/deploy.yml` | manual, tags, `main` con `AUTO_DEPLOY=true` | Despliegue SSH + smoke test |

Permisos: `contents: read` por defecto; `packages: write` solo en el Release y
`contents: write` solo para crear el Release. Las acciones están fijadas por
versión mayor y Dependabot las actualiza.

## CI en detalle

1. **Auditoría**: `bash -n`, `py_compile`, `node --check`, ShellCheck, YAML y
   `docker compose config` con un `.env` de pruebas (no contiene secretos
   reales).
2. **Tests del API**: `npm test` (16 casos).
3. **Auditoría del repo**: `tools/repo-audit.mjs` (archivos, hashes, fugas,
   referencias de workflows).
4. **Autoprueba E2E**: descarga Chrome y ejecuta `tools/e2e-desktop.mjs
   --selftest` (valida el instrumento con una fixture, sin servidor).
5. **Build**: matriz nativa `ubuntu-latest` (amd64) y `ubuntu-24.04-arm`
   (arm64), sin QEMU. Compila API, gateway y escritorio, valida la plantilla
   nginx con un certificado de prueba, comprueba `chromium --version` y los
   binarios de KasmVNC, y arranca el gateway para probar `/healthz`.

La verificación de detección contra Apps Script es opcional (necesita red hacia
`script.google.com`). Actívala con la variable de repositorio
`RUN_DETECTION_CHECK=true`.

## Secrets para desplegar

Configura en **Settings → Secrets and variables → Actions**:

| Nombre | Tipo | Valor |
|---|---|---|
| `DEPLOY_HOST` | secret | IP o host del servidor |
| `DEPLOY_USER` | secret | `ubuntu` (o el usuario SSH) |
| `DEPLOY_SSH_KEY` | secret | clave privada ed25519 completa |
| `DEPLOY_KNOWN_HOSTS` | secret | `ssh-keyscan -H <host>` |
| `CLOUDDESK_PASSWORD` | secret | contraseña del panel (opcional) |
| `DEPLOY_PATH` | variable | `/opt/clouddesk` |
| `AUTO_DEPLOY` | variable | `true` para desplegar en cada push a `main` |

Crear el par de claves:

```bash
ssh-keygen -t ed25519 -C clouddesk-deploy -f ~/.ssh/clouddesk_deploy
ssh-copy-id -i ~/.ssh/clouddesk_deploy.pub ubuntu@IP
ssh-keyscan -H IP > known_hosts
```

Con la CLI:

```bash
gh secret set DEPLOY_HOST --body "IP"
gh secret set DEPLOY_USER --body "ubuntu"
gh secret set DEPLOY_SSH_KEY < ~/.ssh/clouddesk_deploy
gh secret set DEPLOY_KNOWN_HOSTS < known_hosts
gh variable set DEPLOY_PATH --body "/opt/clouddesk"
gh variable set AUTO_DEPLOY --body "false"
```

Sin `DEPLOY_HOST`/`DEPLOY_SSH_KEY`, el workflow de despliegue se omite con un
aviso (no falla).

## Flujo de despliegue

```
push/merge → CI (build + tests)
          → Deploy (SSH): git fetch + checkout <ref> + update.sh
          → smoke-test.sh (sin escribir la contraseña en logs)
```

`update.sh` reconstruye imágenes en el servidor. Si prefieres no compilar en la
VM (2 OCPU), publica un Release y usa las imágenes de GHCR:

```bash
CLOUDDESK_VERSION=1.0.0 docker compose -f docker-compose.yml \
  -f docker-compose.prod.yml up -d --no-build --pull always
```

## Release

```bash
git tag v1.0.0
git push origin v1.0.0
```

Publica:

- `ghcr.io/keinergarcia/clouddesk-api:1.0.0`, `:latest`, `:sha-<commit>`
- `ghcr.io/keinergarcia/clouddesk-gateway:...`
- `ghcr.io/keinergarcia/clouddesk-desktop:...`
- Release con `clouddesk-1.0.0.tar.gz` y su `.sha256`.

El paquete se genera con `git archive` (solo contenido versionado):
`./scripts/make-release.sh 1.0.0`.

## Ejecutar lo mismo en local

```bash
for f in scripts/*.sh; do bash -n "$f"; done
node tools/repo-audit.mjs
cd api && npm test && cd ..
node tools/e2e-desktop.mjs --selftest
```

En Windows usa Git Bash o WSL; `docker compose config` requiere Docker.
