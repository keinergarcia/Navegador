# Seguridad

## Modelo de amenaza

CloudDesk expone un escritorio completo a Internet a través de HTTPS. Los
activos a proteger son:

1. La sesión del escritorio (perfil de Chromium, descargas, cuentas abiertas).
2. Los secretos de configuración (`.env`, certificados, `.kasmpasswd`).
3. El propio servidor (SSH, Docker).

Un atacante remoto sin credenciales no debe poder: abrir el escritorio, ejecutar
acciones del agente, leer cookies de sesión ajenas ni acceder a Docker.

## Controles implementados

| Área | Control |
|---|---|
| Autenticación | Contraseña única, hash scrypt (N=16384, r=8, p=1), mínimo 12 caracteres |
| Sesión | Cookie `HttpOnly; Secure; SameSite=Lax` firmada con HMAC-SHA256, caducidad y `Domain` explícito |
| CSRF | Token por sesión + comprobación de `Origin`/`Referer` en escrituras |
| Fuerza bruta | Límite en memoria por IP (5 intentos/15 min) + `limit_req` de nginx (10 r/min) |
| TLS | TLS 1.2/1.3, cifrados modernos, HSTS, `ssl_reject_handshake` para hosts desconocidos |
| Cabeceras | CSP, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options: DENY` en el panel |
| Aislamiento | `desktop` y `api` sin privilegios, `no-new-privileges`, `cap_drop: ALL` en el API, `read_only` en el API |
| Exposición | Solo 80/443 publicados; KasmVNC (8444) y el agente (8099) en red interna |
| KasmVNC | `auth_request` en nginx; credenciales Basic inyectadas por el proxy, nunca por el navegador |
| Secretos | Generados con `openssl`/`secrets`, `.env` modo 600, `.gitignore`, auditoría de fugas en CI |
| Cadena de suministro | SHA-256 de KasmVNC fijado en ARM64 **y** AMD64; Dependabot semanal |
| Contenedores | Sin socket de Docker montado; `tmpfs` para `/tmp`; límites de CPU/memoria |

## Superficie expuesta

```
80/tcp   → solo ACME + redirección a HTTPS
443/tcp  → panel y escritorio (auth_request)
22/tcp   → SSH (recomendado: solo claves, IP restringida)
8444     → NUNCA publicado
8099     → NUNCA publicado
```

Verificación rápida:

```bash
docker compose ps                 # solo 80/443 en edge
ss -ltnp | grep -E '8444|8099'    # no debe aparecer en el host
```

## Gestión de secretos

- `.env` se genera en el servidor y **nunca** se versiona.
- `VNC_PASSWORD` solo se usa entre nginx y KasmVNC; el navegador no la recibe.
- En GitHub Actions los secretos van en `Settings → Secrets and variables →
  Actions`; no se imprimen en los logs.
- Para rotar la contraseña del panel: `./scripts/set-password.sh`.
- Para rotar todos los secretos: `./scripts/bootstrap.sh --force` (invalida
  sesiones y credenciales VNC; el escritorio se reinicia).

## Riesgos aceptados

1. **`--no-sandbox` en Chromium** dentro del contenedor. Es necesario para
   ejecutar Chromium sin namespaces de usuario y se compensa con usuario no
   root, `no-new-privileges`, sin dispositivos y sin socket de Docker. Si el
   kernel del host permite user namespaces, se puede quitar y volver a probar.
2. **Sin MFA** en el panel: diseño de un solo usuario. Si el servicio se hace
   público, añadir MFA en el proxy (Authelia/oauth2-proxy) o restringir por IP.
3. **Sesión única compartida** (KasmVNC `shared`): no hay aislamiento
   multiusuario; es un escritorio personal.
4. **Contraseña de KasmVNC** almacenada en `.kasmpasswd` dentro del volumen:
   protegida por permisos 0600 y por el aislamiento del contenedor.

## Checklist antes de exponer el servicio

- [ ] Contraseña del panel de 16+ caracteres, única, en un gestor.
- [ ] `AUTH_PASSWORD_HASH` generado con `scripts/bootstrap.sh` (no pegado a mano).
- [ ] DNS en **DNS only** si se usa Cloudflare.
- [ ] `issue-cert.sh` completado y `smoke-test.sh` en verde.
- [ ] SSH solo con clave (`scripts/harden-ssh.sh`) y, si es posible, IP fija.
- [ ] `docker compose ps` sin 8444/8099 publicados.
- [ ] Backups programados (`clouddesk-backup.timer`) y restauración probada.
- [ ] Actualizaciones: `unattended-upgrades` activo y `update.sh` periódico.
- [ ] `AUTO_DEPLOY` desactivado si no se quiere desplegar en cada push.

## Recomendaciones futuras

- Fijar las imágenes base por digest (además de Dependabot).
- Añadir MFA al panel o lista de IPs permitidas.
- Ejecutar `fail2ban` sobre SSH y nginx.
- Firmar/verificar imágenes con `cosign` y publicar SBOM.
- Rotar secretos cada 6–12 meses.
