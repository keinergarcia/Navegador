import http from "node:http";
import process from "node:process";

import { config } from "./config.js";
import {
  LoginLimiter,
  checkCsrf,
  createSession,
  parseCookies,
  serializeCookie,
  verifyPassword,
  verifySession,
} from "./auth.js";
import { AgentError, agent } from "./agent.js";
import { clientIp, logRequest, readJsonBody, sendEmpty, sendJson } from "./http.js";

const SESSION_COOKIE_MAX_AGE = 400 * 24 * 3600; // límite duro del navegador
const panelOrigin = (config.panelOrigin || `http://localhost:${config.port}`).replace(/\/+$/, "");
const limiter = new LoginLimiter({
  maxAttempts: config.loginMaxAttempts,
  windowMinutes: config.loginWindowMinutes,
});

const PRESETS = [
  { label: "1366 × 768 · Escritorio", width: 1366, height: 768 },
  { label: "1280 × 720 · Ligero", width: 1280, height: 720 },
  { label: "1024 × 768 · Clásico", width: 1024, height: 768 },
  { label: "1600 × 900 · Amplio", width: 1600, height: 900 },
  { label: "1920 × 1080 · Full HD", width: 1920, height: 1080 },
];

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "Lax",
    domain: config.cookieDomain || undefined,
    maxAge,
    path: "/",
  };
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[config.cookieName];
  if (!token) return { payload: null, token: null };
  return { payload: verifySession(config.sessionSecret, token), token };
}

async function requireAuth(req, res, { csrf = false } = {}) {
  const { payload } = getSession(req);
  if (!payload) {
    sendJson(res, 401, { error: { code: "unauthenticated", message: "Sesión no válida o expirada" } });
    return null;
  }
  if (csrf && !checkCsrf(req, payload, panelOrigin)) {
    sendJson(res, 403, { error: { code: "csrf", message: "Token CSRF inválido" } });
    return null;
  }
  return payload;
}

function handleError(res, error) {
  if (error instanceof AgentError) {
    const status = error.status >= 500 ? 502 : 400;
    sendJson(res, status, {
      error: { code: "agent", message: "No se pudo comunicar con el escritorio" },
      detail: error.message,
    });
    return;
  }
  if (error?.code === "invalid_json") {
    sendJson(res, 400, { error: { code: "invalid_json", message: "JSON inválido" } });
    return;
  }
  if (error?.code === "body_too_large") {
    sendJson(res, 413, { error: { code: "body_too_large", message: "Cuerpo demasiado grande" } });
    return;
  }
  process.stderr.write(`[api] error no controlado: ${error?.stack || error}\n`);
  sendJson(res, 500, { error: { code: "internal", message: "Error interno" } });
}

// --------------------------------------------------------------------------- //
// Rutas
// --------------------------------------------------------------------------- //
async function route(req, res) {
  const url = new URL(req.url || "/", "http://internal");
  const path = url.pathname;
  const method = req.method || "GET";

  // --- salud (sin autenticación, para healthchecks) ------------------------
  if (path === "/api/health" && method === "GET") {
    sendJson(res, 200, { ok: true, version: config.version });
    return;
  }

  // --- autenticación -------------------------------------------------------
  if (path === "/api/auth/login" && method === "POST") {
    const ip = clientIp(req);
    if (!limiter.allow(ip)) {
      const retry = limiter.retryAfterSeconds(ip);
      sendJson(
        res,
        429,
        { error: { code: "rate_limited", message: "Demasiados intentos. Espera unos minutos." } },
        { "Retry-After": String(retry) },
      );
      return;
    }
    const body = await readJsonBody(req);
    const password = typeof body.password === "string" ? body.password : "";
    const remember = body.remember === true;
    const ok = password.length > 0 && password.length <= 512 &&
      (await verifyPassword(password, config.passwordHash));
    if (!ok) {
      limiter.fail(ip);
      process.stdout.write(`[api] login fallido desde ${ip}\n`);
      sendJson(res, 401, { error: { code: "bad_credentials", message: "Contraseña incorrecta" } });
      return;
    }
    limiter.reset(ip);
    const ttl = (remember ? config.rememberDays * 86400 : config.sessionHours * 3600);
    const { token, payload } = createSession(config.sessionSecret, { ttlSeconds: ttl });
    res.setHeader("Set-Cookie", serializeCookie(config.cookieName, token, cookieOptions(ttl)));
    process.stdout.write(`[api] login correcto desde ${ip}\n`);
    sendJson(res, 200, {
      ok: true,
      authenticated: true,
      csrf: payload.csrf,
      expiresAt: payload.exp * 1000,
    });
    return;
  }

  if (path === "/api/auth/logout" && method === "POST") {
    res.setHeader("Set-Cookie", serializeCookie(config.cookieName, "", cookieOptions(0)));
    sendEmpty(res, 204);
    return;
  }

  // Subpetición interna de nginx (auth_request). No debe devolver cuerpo.
  if (path === "/api/auth/verify" && method === "GET") {
    const { payload } = getSession(req);
    if (!payload) {
      sendEmpty(res, 401);
      return;
    }
    sendEmpty(res, 204, { "X-CloudDesk-Expires": String(payload.exp * 1000) });
    return;
  }

  if (path === "/api/auth/session" && method === "GET") {
    const { payload } = getSession(req);
    if (!payload) {
      sendJson(res, 200, { authenticated: false });
      return;
    }
    sendJson(res, 200, {
      authenticated: true,
      csrf: payload.csrf,
      expiresAt: payload.exp * 1000,
    });
    return;
  }

  // --- estado y control ----------------------------------------------------
  if (path === "/api/status" && method === "GET") {
    if (!(await requireAuth(req, res))) return;
    const base = {
      ok: true,
      panel: { version: config.version, now: Date.now() },
      vnc: { url: config.vncUrl, host: config.vncHost, sameSite: Boolean(config.cookieDomain) },
      presets: PRESETS,
    };
    try {
      const data = await agent.status();
      sendJson(res, 200, { ...base, agentOnline: true, ...data, ok: true });
    } catch (error) {
      sendJson(res, 200, {
        ...base,
        agentOnline: false,
        agentError: error.message,
        session: { state: "unknown" },
        chromium: { processes: 0, rssMb: 0 },
        presets: PRESETS,
      });
    }
    return;
  }

  if (path === "/api/config" && method === "GET") {
    if (!(await requireAuth(req, res))) return;
    sendJson(res, 200, {
      vncUrl: config.vncUrl,
      vncHost: config.vncHost,
      presets: PRESETS,
      version: config.version,
    });
    return;
  }

  if (path === "/api/heartbeat" && method === "POST") {
    if (!(await requireAuth(req, res, { csrf: true }))) return;
    try {
      await agent.heartbeat();
    } catch {
      // El heartbeat es best-effort: no debe romper la UI.
    }
    sendEmpty(res, 204);
    return;
  }

  const actionMatch = path.match(/^\/api\/session\/(start|stop|restart)$/);
  if (actionMatch && method === "POST") {
    if (!(await requireAuth(req, res, { csrf: true }))) return;
    const action = actionMatch[1];
    const result = await agent[action]();
    sendJson(res, 200, { ok: true, action, result });
    return;
  }

  if (path === "/api/session/resolution" && method === "POST") {
    if (!(await requireAuth(req, res, { csrf: true }))) return;
    const body = await readJsonBody(req);
    const width = Number(body.width);
    const height = Number(body.height);
    const valid =
      Number.isInteger(width) &&
      Number.isInteger(height) &&
      width >= 640 &&
      width <= 1920 &&
      height >= 360 &&
      height <= 1200 &&
      width * height <= 2_304_000 &&
      width % 2 === 0 &&
      height % 2 === 0;
    if (!valid) {
      sendJson(res, 400, {
        error: { code: "invalid_dimensions", message: "Resolución fuera de rango" },
      });
      return;
    }
    const result = await agent.setResolution(width, height);
    sendJson(res, 200, { ok: true, result });
    return;
  }

  sendJson(res, 404, { error: { code: "not_found", message: "Ruta no encontrada" } });
}

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  const originalEnd = res.end.bind(res);
  res.end = (...args) => {
    logRequest(req, res, startedAt);
    return originalEnd(...args);
  };
  Promise.resolve(route(req, res))
    .catch((error) => {
      if (!res.headersSent) handleError(res, error);
      else res.destroy();
    })
    .finally(() => {
      if (!res.writableEnded) res.end();
    });
});

server.headersTimeout = 15_000;
server.requestTimeout = 90_000;
server.keepAliveTimeout = 5_000;

server.listen(config.port, process.env.BIND_HOST || "0.0.0.0", () => {
  process.stdout.write(
    `[api] CloudDesk ${config.version} escuchando en :${config.port} ` +
      `(origin=${panelOrigin}, vnc=${config.vncUrl || "no definido"})\n`,
  );
});

function shutdown(signal) {
  process.stdout.write(`[api] ${signal}: cerrando\n`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
