# CloudDesk en GitHub Codespaces (gratis, sin dominio)

Codespaces ofrece una máquina Linux con Docker-in-Docker y reenvío HTTPS de
puertos. Es la forma más rápida de ejecutar el escritorio y la prueba E2E sin
contratar nada.

## Límites del plan gratuito (cuenta personal)

- **120 core-hours/mes**: con la máquina de 2 núcleos son ~60 horas reales.
- **15 GB-mes de almacenamiento**.
- Parada automática por inactividad a los 30 minutos (configurable).
- El espacio se suspende, no se borra, al pararlo.
- No requiere tarjeta.

> Detén el Codespace al terminar (`gh codespace stop -c NOMBRE` o desde la UI):
> el tiempo consumido cuenta desde que arranca hasta que se para.

## Qué se ejecuta aquí

Solo el contenedor **desktop** (XFCE + Chromium + KasmVNC) y su puerto 8444.
El stack completo (panel + edge) no se usa porque nginx enruta por nombre de
host (`desk.*` y `vnc.*`) y Codespaces publica un hostname distinto por puerto.
Para validar el stack completo está Oracle (`docs/DESPLIEGUE-ORACLE.md`).

El contenedor se arranca con `CLOUDDESK_E2E_DEBUG=1`, que habilita CDP en
`127.0.0.1:9222` **solo dentro del Codespace**, para que la prueba E2E pueda
inspeccionar el Chromium real. El puerto no se publica a Internet.

## Crear el Codespace

### Desde la web

1. Abre <https://github.com/keinergarcia/Navegador>.
2. **Code → Codespaces → Create codespace on main**.
3. Espera a que termine el `postCreate` (instala Docker-in-Docker).

### Desde la CLI

```bash
gh codespace create -R keinergarcia/Navegador -b main \
  --machine basicLinux32gb --idle-timeout 30m
gh codespace ssh -c <nombre>
```

## Arrancar el escritorio

Dentro del Codespace:

```bash
./scripts/codespaces-up.sh --check-only   # Docker + compose
./scripts/codespaces-up.sh                # build (10-20 min) + arranque
```

Salida esperada:

```
Escritorio arrancado.
  URL        : https://<codespace>-8444.app.github.dev
  Usuario    : desk
  Contraseña : <generada>
  CDP (E2E)  : http://127.0.0.1:9222
```

- Abre la URL en el navegador. Si el puerto no aparece, ve a **Ports**, busca
  `8444` y pulsa el icono del globo.
- La visibilidad por defecto es **privada**: solo entra tu sesión de GitHub.
- No la pongas pública: KasmVNC quedaría accesible con solo la contraseña.

## Prueba end-to-end

```bash
./scripts/codespaces-e2e.sh
```

Hace tres cosas:

1. `tools/check-deteccion-clouddesk.mjs` con el despliegue real de Apps Script.
2. Abre la app dentro del Chromium del escritorio y comprueba las señales
   reales (táctil 0, puntero fino, 1366×768) y que `esMovil()` devuelve `false`.
3. Guarda una captura en `tests/.artifacts/e2e-escritorio-*.png`.

Códigos de salida: `0` verificado, `1` fallo, `2` pendiente (la app pide login).
Si sale `2`, inicia sesión en el Chromium del escritorio y repite; o pasa
`--url` con la URL concreta.

## Problemas frecuentes

| Síntoma | Solución |
|---|---|
| `docker info` falla en el primer minuto | El daemon de DinD aún arranca; espera y repite `--check-only` |
| Build abortado por memoria | Usa la máquina de 4 núcleos/16 GB (consume más cuota) o añade swap |
| El puerto 8444 da 502 | El contenedor aún arranca; `./scripts/codespaces-up.sh --status` y `--logs` |
| KasmVNC carga pero no conecta | Revisa que entras por HTTPS del reenvío, no por `127.0.0.1` desde tu PC |
| "Sesión no válida" en la app de Google | Inicia sesión en Chromium; la detección no depende de la cuenta |
| Se agota la cuota | Para el Codespace; borra los que no uses (`gh codespace delete`) |

## Seguridad

- Puerto 8444 privado (solo tu cuenta de GitHub).
- Contraseña de KasmVNC generada aleatoriamente (24 caracteres) y guardada en
  `tests/.artifacts/codespaces-vnc-password` (ignorado por Git).
- CDP en `127.0.0.1` del host del Codespace; no se publica.
- No se guardan secretos en el repositorio.
