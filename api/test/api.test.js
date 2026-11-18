// Prueba de integración: arranca el API real y un agente simulado.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { hashPassword } from "../src/auth.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "a".repeat(64);
const PASSWORD = "prueba-local-1234";

let agentProc;
let apiProc;
let apiBase;
let cookie = "";
let csrf = "";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // reintentar
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`No respondió: ${url}`);
}

before(async () => {
  const agentPort = await freePort();
  const apiPort = await freePort();
  const env = {
    ...process.env,
    AGENT_TOKEN: TOKEN,
    AUTH_PASSWORD_HASH: await hashPassword(PASSWORD),
    SESSION_SECRET: "s".repeat(64),
    AGENT_URL: `http://127.0.0.1:${agentPort}`,
    PANEL_ORIGIN: `http://127.0.0.1:${apiPort}`,
    VNC_URL: "https://vnc.example.test/",
    VNC_HOST: "vnc.example.test",
    INSECURE_COOKIES: "1",
    PORT: String(apiPort),
    NODE_ENV: "test",
    APP_VERSION: "test",
  };

  agentProc = spawn(process.execPath, [path.join(ROOT, "tools", "mock-agent.mjs"), String(agentPort)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  apiProc = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  apiProc.stderr.on("data", (d) => process.stderr.write(`[api-test] ${d}`));

  apiBase = `http://127.0.0.1:${apiPort}`;
  await waitFor(`${apiBase}/api/health`);
});

after(() => {
  apiProc?.kill("SIGTERM");
  agentProc?.kill("SIGTERM");
});

const authHeaders = () => ({
  Cookie: cookie,
  "X-CloudDesk-CSRF": csrf,
  "Content-Type": "application/json",
  Origin: apiBase,
});

test("health responde sin autenticación", async () => {
  const res = await fetch(`${apiBase}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, version: "test" });
});

test("status exige autenticación", async () => {
  const res = await fetch(`${apiBase}/api/status`);
  assert.equal(res.status, 401);
});

test("login con contraseña incorrecta", async () => {
  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: apiBase },
    body: JSON.stringify({ password: "incorrecta-12345" }),
  });
  assert.equal(res.status, 401);
});

test("login correcto y cookie HttpOnly", async () => {
  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: apiBase },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  const setCookie = res.headers.getSetCookie().join(";");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const match = setCookie.match(/cd_session=([^;]+)/);
  assert.ok(match, "cookie cd_session presente");
  cookie = `cd_session=${match[1]}`;
  const body = await res.json();
  csrf = body.csrf;
  assert.ok(csrf);
});

test("sesión válida y estado del agente", async () => {
  const session = await fetch(`${apiBase}/api/auth/session`, { headers: { Cookie: cookie } });
  const sessionBody = await session.json();
  assert.equal(sessionBody.authenticated, true);

  const verify = await fetch(`${apiBase}/api/auth/verify`, { headers: { Cookie: cookie } });
  assert.equal(verify.status, 204);

  const res = await fetch(`${apiBase}/api/status`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.agentOnline, true);
  assert.equal(body.session.state, "running");
  assert.equal(body.session.resolution.width, 1366);
  assert.equal(body.vnc.url, "https://vnc.example.test/");
});

test("las acciones exigen CSRF", async () => {
  const noCsrf = await fetch(`${apiBase}/api/session/restart`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: apiBase },
  });
  assert.equal(noCsrf.status, 403);

  const ok = await fetch(`${apiBase}/api/session/restart`, {
    method: "POST",
    headers: authHeaders(),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
});

test("cambio de resolución validado", async () => {
  const bad = await fetch(`${apiBase}/api/session/resolution`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ width: 100, height: 100 }),
  });
  assert.equal(bad.status, 400);

  const good = await fetch(`${apiBase}/api/session/resolution`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ width: 1280, height: 720 }),
  });
  assert.equal(good.status, 200);
  const body = await good.json();
  assert.deepEqual(body.result.resolution, { width: 1280, height: 720 });
});

test("logout invalida la cookie en el cliente", async () => {
  const res = await fetch(`${apiBase}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: apiBase },
  });
  assert.equal(res.status, 204);
  assert.match(res.headers.getSetCookie().join(";"), /Max-Age=0/);
});
