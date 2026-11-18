#!/usr/bin/env bash
# =============================================================================
# CloudDesk - prueba de humo contra el despliegue real.
#
# Uso:
#   ./scripts/smoke-test.sh                       # comprobaciones sin sesión
#   ./scripts/smoke-test.sh --password-stdin      # + login y acceso al VNC
#   ./scripts/smoke-test.sh --local               # resuelve los hosts a 127.0.0.1
#   ./scripts/smoke-test.sh --insecure            # acepta certificado autofirmado
#
# La contraseña se lee de stdin o de la variable CLOUDDESK_PASSWORD; nunca se
# pasa por argumentos (evita que aparezca en `ps`).
# =============================================================================
source "$(dirname "$0")/lib.sh"

PASSWORD=""
READ_PASSWORD=0
ALLOW_INSECURE=0
LOCAL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --password-stdin) READ_PASSWORD=1; shift ;;
    --insecure) ALLOW_INSECURE=1; shift ;;
    --local) LOCAL=1; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "opción desconocida: $1" ;;
  esac
done

require_cmd curl openssl
load_env

if [[ "$READ_PASSWORD" -eq 1 ]]; then
  IFS= read -r PASSWORD || true
elif [[ -n "${CLOUDDESK_PASSWORD:-}" ]]; then
  PASSWORD="$CLOUDDESK_PASSWORD"
fi

PASS=0
FAIL=0
WARN=0
TMPDIR_TEST="$(mktemp -d "${TMPDIR:-/tmp}/clouddesk-smoke.XXXXXX")"
trap 'rm -rf "$TMPDIR_TEST"' EXIT
JAR="$TMPDIR_TEST/cookies.txt"

pass() { PASS=$((PASS + 1)); printf '  %s %s\n' "${C_GREEN}PASS${C_RESET}" "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '  %s %s\n' "${C_RED}FAIL${C_RESET}" "$*"; }
note() { WARN=$((WARN + 1)); printf '  %s %s\n' "${C_YELLOW}WARN${C_RESET}" "$*"; }
section() { printf '\n%s\n' "${C_BOLD}$*${C_RESET}"; }

CURL=(curl -sS --max-time 20 --connect-timeout 8)
RESOLVE=()
if [[ "$LOCAL" -eq 1 ]]; then
  RESOLVE=(--resolve "$PANEL_HOST:443:127.0.0.1" --resolve "$PANEL_HOST:80:127.0.0.1"
           --resolve "$VNC_HOST:443:127.0.0.1" --resolve "$VNC_HOST:80:127.0.0.1")
fi

# Detección de TLS: primero estricto; si falla por certificado, se reintenta -k.
TLS=()
if ! "${CURL[@]}" "${RESOLVE[@]}" -o /dev/null "https://$PANEL_HOST/healthz" 2>"$TMPDIR_TEST/tls.err"; then
  if [[ "$ALLOW_INSECURE" -eq 1 ]] || grep -qiE 'certificate|SSL' "$TMPDIR_TEST/tls.err"; then
    TLS=(-k)
    note 'certificado TLS no válido (¿autofirmado?). Se continúa con -k; emite el real con issue-cert.sh.'
  else
    fail "no se pudo conectar a https://$PANEL_HOST: $(tr '\n' ' ' < "$TMPDIR_TEST/tls.err")"
  fi
fi
HTTP=("${CURL[@]}" "${TLS[@]}" "${RESOLVE[@]}")

printf '%s\n' "${C_BOLD}CloudDesk · prueba de humo${C_RESET}"
printf '%s\n' "${C_DIM}$(date -u '+%Y-%m-%dT%H:%M:%SZ') · panel=$PANEL_HOST · vnc=$VNC_HOST${C_RESET}"

# --------------------------------------------------------------------------- #
section '1. Redirección HTTP -> HTTPS'
read -r CODE LOCATION < <("${CURL[@]}" "${RESOLVE[@]}" -o /dev/null -w '%{http_code} %{redirect_url}\n' "http://$PANEL_HOST/" || echo '000 ')
if [[ "$CODE" == "301" && "$LOCATION" == "https://$PANEL_HOST/" ]]; then
  pass "http://$PANEL_HOST -> $LOCATION"
else
  fail "esperaba 301 a https://$PANEL_HOST/, obtuve $CODE $LOCATION"
fi

# --------------------------------------------------------------------------- #
section '2. Salud del panel'
BODY="$("${HTTP[@]}" "https://$PANEL_HOST/healthz" || true)"
[[ "$BODY" == "ok" ]] && pass 'GET /healthz = ok' || fail "GET /healthz devolvió: ${BODY:-<vacío>}"

API_JSON="$("${HTTP[@]}" "https://$PANEL_HOST/api/health" || true)"
if grep -q '"ok":true' <<<"$API_JSON"; then
  pass "GET /api/health = $API_JSON"
else
  fail "GET /api/health devolvió: ${API_JSON:-<vacío>}"
fi

VNC_OFFLINE="$("${HTTP[@]}" -o /dev/null -w '%{http_code}' "https://$VNC_HOST/api/health" || true)"
[[ "$VNC_OFFLINE" == "404" || "$VNC_OFFLINE" == "302" ]] \
  && pass "el host VNC no expone la API (HTTP $VNC_OFFLINE)" \
  || note "el host VNC respondió $VNC_OFFLINE a /api/health (revisa el server_name)"

# --------------------------------------------------------------------------- #
section '3. Cabeceras de seguridad'
HEADERS="$("${HTTP[@]}" -D - -o /dev/null "https://$PANEL_HOST/healthz" || true)"
grep -qi '^Strict-Transport-Security: max-age=31536000' <<<"$HEADERS" \
  && pass 'HSTS presente' || fail 'falta Strict-Transport-Security'
grep -qi '^X-Content-Type-Options: nosniff' <<<"$HEADERS" \
  && pass 'X-Content-Type-Options: nosniff' || fail 'falta X-Content-Type-Options'
grep -qi '^Content-Security-Policy:' <<<"$HEADERS" \
  && pass 'Content-Security-Policy presente' || fail 'falta Content-Security-Policy'
grep -qi '^Server: nginx$' <<<"$HEADERS" \
  && pass 'server_tokens off (sin versión)' || note 'la cabecera Server no es exactamente "nginx"'

# --------------------------------------------------------------------------- #
section '4. Acceso sin sesión'
CODE="$("${HTTP[@]}" -o /dev/null -w '%{http_code}' "https://$PANEL_HOST/desktop.html" || true)"
[[ "$CODE" == "302" ]] && pass 'desktop.html sin sesión -> 302 al panel' || fail "desktop.html sin sesión devolvió $CODE"

CODE="$("${HTTP[@]}" -o /dev/null -w '%{http_code}' "https://$VNC_HOST/" || true)"
[[ "$CODE" == "302" ]] && pass 'KasmVNC sin sesión -> 302 al panel' || fail "KasmVNC sin sesión devolvió $CODE"

CODE="$("${HTTP[@]}" -o /dev/null -w '%{http_code}' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "https://$VNC_HOST/websockify" || true)"
[[ "$CODE" == "302" ]] && pass 'WebSocket sin sesión rechazado (302)' || fail "WebSocket sin sesión devolvió $CODE"

# --------------------------------------------------------------------------- #
section '5. Login y sesión'
if [[ -z "$PASSWORD" ]]; then
  note 'sin contraseña: se omiten las pruebas autenticadas (usa --password-stdin).'
else
  LOGIN_HEADERS="$TMPDIR_TEST/login.headers"
  LOGIN_BODY="$TMPDIR_TEST/login.json"
  CODE="$("${HTTP[@]}" -c "$JAR" -D "$LOGIN_HEADERS" -o "$LOGIN_BODY" -w '%{http_code}' \
    -H 'Content-Type: application/json' -H "Origin: https://$PANEL_HOST" \
    --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"password": sys.stdin.read()}))' <<<"$PASSWORD")" \
    "https://$PANEL_HOST/api/auth/login" || true)"

  if [[ "$CODE" == "200" ]] && grep -q '"authenticated":true' "$LOGIN_BODY"; then
    pass 'POST /api/auth/login = 200'
  else
    fail "login devolvió $CODE: $(head -c 200 "$LOGIN_BODY")"
  fi

  SET_COOKIE="$(grep -i '^Set-Cookie:' "$LOGIN_HEADERS" || true)"
  grep -qi 'HttpOnly' <<<"$SET_COOKIE" && pass 'cookie HttpOnly' || fail 'la cookie no es HttpOnly'
  grep -qi 'Secure' <<<"$SET_COOKIE" && pass 'cookie Secure' || fail 'la cookie no es Secure'
  grep -qi 'SameSite=Lax' <<<"$SET_COOKIE" && pass 'cookie SameSite=Lax' || fail 'la cookie no es SameSite=Lax'
  grep -qi "Domain=$COOKIE_DOMAIN" <<<"$SET_COOKIE" && pass "cookie Domain=$COOKIE_DOMAIN" || note "cookie sin Domain=$COOKIE_DOMAIN"

  CODE="$("${HTTP[@]}" -b "$JAR" -o "$TMPDIR_TEST/status.json" -w '%{http_code}' "https://$PANEL_HOST/api/status" || true)"
  [[ "$CODE" == "200" ]] && pass 'GET /api/status con sesión = 200' || fail "GET /api/status devolvió $CODE"

  CODE="$("${HTTP[@]}" -b "$JAR" -o /dev/null -w '%{http_code}' "https://$PANEL_HOST/desktop.html" || true)"
  [[ "$CODE" == "200" ]] && pass 'desktop.html con sesión = 200' || fail "desktop.html con sesión devolvió $CODE"

  # CSRF: un POST sin token debe rechazarse.
  CODE="$("${HTTP[@]}" -b "$JAR" -o /dev/null -w '%{http_code}' \
    -X POST -H "Origin: https://$PANEL_HOST" "https://$PANEL_HOST/api/heartbeat" || true)"
  [[ "$CODE" == "403" ]] && pass 'POST sin token CSRF -> 403' || fail "POST sin CSRF devolvió $CODE (esperaba 403)"

  VNC_HEADERS="$TMPDIR_TEST/vnc.headers"
  CODE="$("${HTTP[@]}" -b "$JAR" -D "$VNC_HEADERS" -o "$TMPDIR_TEST/vnc.html" -w '%{http_code}' "https://$VNC_HOST/" || true)"
  if [[ "$CODE" == "200" ]]; then
    pass 'KasmVNC con sesión = 200'
    if grep -qi '^WWW-Authenticate:' "$VNC_HEADERS"; then
      fail 'KasmVNC pidió Basic Auth al navegador (Safari fallaría)'
    else
      pass 'KasmVNC no devuelve WWW-Authenticate (credenciales inyectadas por nginx)'
    fi
    grep -qi 'kasm' "$TMPDIR_TEST/vnc.html" && pass 'la respuesta parece el cliente KasmVNC' || note 'no se encontró "kasm" en el HTML del visor'
  else
    fail "KasmVNC con sesión devolvió $CODE"
  fi

  CODE="$("${HTTP[@]}" -b "$JAR" -o /dev/null -w '%{http_code}' -X POST \
    -H "Origin: https://$PANEL_HOST" "https://$PANEL_HOST/api/auth/logout" || true)"
  [[ "$CODE" == "204" ]] && pass 'logout = 204' || fail "logout devolvió $CODE"
fi

# --------------------------------------------------------------------------- #
printf '\n%s\n' "${C_BOLD}Resumen${C_RESET}: ${C_GREEN}$PASS correctas${C_RESET}, ${C_RED}$FAIL fallidas${C_RESET}, ${C_YELLOW}$WARN avisos${C_RESET}"
[[ "$FAIL" -eq 0 ]] || exit 1
