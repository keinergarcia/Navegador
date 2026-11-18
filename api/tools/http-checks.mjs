// Comprobaciones HTTP contra un API en marcha (por defecto, el de `make dev`).
//
// Uso:
//   node api/tools/http-checks.mjs
//   BASE=http://127.0.0.1:18080 PASSWORD=... node api/tools/http-checks.mjs
//
// No forma parte de `npm test` porque necesita un servidor y un agente vivos.
// Las pruebas unitarias/de integración están en api/test/.
const BASE = (process.env.BASE || "http://127.0.0.1:18080").replace(/\/+$/, "");
const PASSWORD = process.env.PASSWORD || "clouddesk-dev-password";
const ORIGIN = process.env.ORIGIN || "http://127.0.0.1:8088";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name} ${detail}`);
  }
};

let res = await fetch(`${BASE}/api/health`);
check("health 200", res.status === 200);

res = await fetch(`${BASE}/api/status`);
check("status sin cookie 401", res.status === 401);

// Rate limit con IP simulada (el API usa X-Real-IP, igual que nginx).
const ip = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
let last;
for (let i = 0; i < 5; i += 1) {
  last = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Real-IP": ip },
    body: JSON.stringify({ password: "contraseña-incorrecta" }),
  });
}
check("5 intentos incorrectos 401", last.status === 401, String(last.status));
const blocked = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Real-IP": ip },
  body: JSON.stringify({ password: PASSWORD }),
});
check("6º intento 429", blocked.status === 429, String(blocked.status));
check("Retry-After presente", Boolean(blocked.headers.get("retry-after")));

// Login correcto desde otra IP.
const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Real-IP": "198.51.100.7", Origin: ORIGIN },
  body: JSON.stringify({ password: PASSWORD }),
});
const loginBody = await login.json();
check("login 200", login.status === 200, String(login.status));
check("csrf en respuesta", typeof loginBody.csrf === "string" && loginBody.csrf.length > 20);
const setCookie = login.headers.get("set-cookie") || "";
check("cookie HttpOnly", /HttpOnly/i.test(setCookie), setCookie);
check("cookie SameSite=Lax", /SameSite=Lax/i.test(setCookie), setCookie);
const cookie = setCookie.split(";")[0];

const hb = await fetch(`${BASE}/api/heartbeat`, {
  method: "POST",
  headers: { Cookie: cookie, Origin: ORIGIN, "X-CloudDesk-CSRF": loginBody.csrf },
});
check("heartbeat con CSRF 204", hb.status === 204, String(hb.status));

const noCsrf = await fetch(`${BASE}/api/heartbeat`, {
  method: "POST",
  headers: { Cookie: cookie, Origin: ORIGIN },
});
check("heartbeat sin CSRF 403", noCsrf.status === 403, String(noCsrf.status));

const badOrigin = await fetch(`${BASE}/api/heartbeat`, {
  method: "POST",
  headers: { Cookie: cookie, Origin: "https://evil.example", "X-CloudDesk-CSRF": loginBody.csrf },
});
check("origen ajeno 403", badOrigin.status === 403, String(badOrigin.status));

const invalid = await fetch(`${BASE}/api/session/resolution`, {
  method: "POST",
  headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json", "X-CloudDesk-CSRF": loginBody.csrf },
  body: JSON.stringify({ width: 400, height: 300 }),
});
check("resolución inválida 400", invalid.status === 400, String(invalid.status));

const valid = await fetch(`${BASE}/api/session/resolution`, {
  method: "POST",
  headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json", "X-CloudDesk-CSRF": loginBody.csrf },
  body: JSON.stringify({ width: 1600, height: 900 }),
});
check("resolución válida 200", valid.status === 200, String(valid.status));

const status = await fetch(`${BASE}/api/status`, { headers: { Cookie: cookie } });
const statusBody = await status.json();
check(
  "status refleja 1600x900",
  statusBody.session?.resolution?.width === 1600 && statusBody.session?.resolution?.height === 900,
);

const logout = await fetch(`${BASE}/api/auth/logout`, {
  method: "POST",
  headers: { Cookie: cookie, Origin: ORIGIN },
});
check("logout 204", logout.status === 204, String(logout.status));
check("logout borra la cookie (Max-Age=0)", /Max-Age=0/i.test(logout.headers.get("set-cookie") || ""));

console.log(`\nResumen: ${pass} correctas, ${fail} fallidas`);
process.exit(fail === 0 ? 0 : 1);
