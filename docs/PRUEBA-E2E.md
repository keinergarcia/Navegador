# Prueba end-to-end del navegador

## Objetivo

Demostrar que la web app de Apps Script ve el entorno de CloudDesk como un PC
real y **no** aplica el bloqueo "Solo desde PC", sin falsificar el navegador ni
tocar la lógica de detección.

## Qué se comprueba (y qué no)

Se comprueba, sobre el Chromium real que corre en el escritorio:

| Señal | Valor esperado |
|---|---|
| `navigator.maxTouchPoints` | `0` |
| `matchMedia("(pointer: coarse)")` | `false` |
| `matchMedia("(any-pointer: fine)")` | `true` |
| `navigator.userAgentData.mobile` | `false` |
| `screen.width × screen.height` | ≥ 1024 × 600 (1366×768 por defecto) |
| `esMovil(...)` del despliegue | `false` (PC) |
| Texto de bloqueo en la página/iframe | ausente |

**No** se comprueba con emulación de dispositivos: `Emulation.setDeviceMetricsOverride`
no se usa en modo real (solo en la autoprueba de la herramienta). Tampoco se
modifica el UA ni se inyecta JavaScript en la app.

## Herramientas

### 1. `tools/check-deteccion-clouddesk.mjs` (lógica)

Descarga el despliegue real de Apps Script, extrae su función `esMovil()` y la
evalúa con los valores que reporta el Chromium de CloudDesk (constantes
documentadas: UA Linux, `finePointer`, `touch: 0`, 1366×768, etc.). Incluye
controles negativos (iPhone normal y iPhone con "sitio de escritorio") que deben
seguir bloqueándose.

```bash
node tools/check-deteccion-clouddesk.mjs
```

Resultado actual: **13/13 PASS**.

### 2. `tools/e2e-desktop.mjs` (navegador real)

Se conecta por CDP al Chromium del escritorio (`127.0.0.1:9222`), abre la app,
recorre todos los contextos (incluido el iframe del `userHtml`) y ejecuta
`esMovil()` allí donde existe. Guarda una captura de pantalla.

```bash
# Codespaces / servidor con el override E2E
node tools/e2e-desktop.mjs --cdp http://127.0.0.1:9222

# URL concreta
node tools/e2e-desktop.mjs --url "https://script.google.com/macros/s/.../exec"
```

Códigos de salida: `0` PC verificado · `1` bloqueo o entorno móvil · `2`
pendiente (la app no expuso `esMovil`, normalmente por login).

### 3. Autoprueba de la herramienta

Valida el propio instrumento con Chrome local y una fixture que simula los dos
casos (permitido y bloqueado):

```bash
node tools/e2e-desktop.mjs --selftest
```

Resultado actual:

```json
{
  "ok": true,
  "casoPC": { "code": 0, "estado": "PC" },
  "casoBloqueado": { "code": 1, "estado": "BLOQUEADO", "alerta": "Solo desde PC" }
}
```

## Cómo habilitar CDP (solo pruebas)

Chromium escucha DevTools en `127.0.0.1` **del contenedor** (la versión actual
ignora `--remote-debugging-address`). Por eso el E2E se ejecuta con red de host:

```bash
docker run -d --name desk-e2e --network host --shm-size=1g \
  -e AGENT_TOKEN=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  -e VNC_PASSWORD=e2e-password-1234 \
  -e CLOUDDESK_E2E_DEBUG=1 \
  clouddesk/desktop:1.5.2

node tools/e2e-desktop.mjs --cdp http://127.0.0.1:9222
docker rm -f desk-e2e
```

El workflow `.github/workflows/e2e.yml` hace exactamente esto en un runner
efímero. En Codespaces (Docker dentro de Docker) el 9222 del contenedor no es
alcanzable desde el host del Codespace: allí se ejecuta la verificación de
`esMovil()` y la prueba de navegador se cubre con el workflow de CI.

## Limitaciones conocidas

1. **Login de Google**: si la app exige cuenta, el script no puede evaluar
   `esMovil()` dentro de la página y devuelve `2` (pendiente). La verificación
   de señales del navegador se sigue mostrando; inicia sesión en el escritorio y
   repite para completar la prueba.
2. **La app puede cambiar**: el script extrae el `esMovil()` del despliegue en
   vivo, no una copia. Si el despliegue cambia, la prueba usa la versión nueva.
3. **Captura de pantalla**: sirve como evidencia visual, pero la decisión se
   toma con los valores del DOM, no con OCR.

## Evidencia a conservar

- Salida JSON de `check-deteccion-clouddesk.mjs` (13 casos).
- Salida JSON de `e2e-desktop.mjs` (entorno + resultado de `esMovil`).
- `tests/.artifacts/e2e-escritorio-*.png`.

Los artefactos están ignorados por Git; adjúntalos al Release o al informe si
necesitas evidencia externa.
