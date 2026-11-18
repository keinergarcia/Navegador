// Autenticación: hash scrypt, cookie firmada (HMAC-SHA256), CSRF y
// limitador de intentos en memoria.
import {
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Deriva un hash scrypt con sal aleatoria. */
export async function hashPassword(password, salt = randomBytes(16)) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("La contraseña debe tener al menos 12 caracteres");
  }
  const derived = await scrypt(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${b64url(salt)}$${b64url(derived)}`;
}

/** Compara una contraseña con un hash almacenado. Nunca lanza por formato. */
export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const params = {
      N: Number.parseInt(n, 10),
      r: Number.parseInt(r, 10),
      p: Number.parseInt(p, 10),
      maxmem: SCRYPT_MAXMEM,
    };
    if (
      !Number.isFinite(params.N) ||
      !Number.isFinite(params.r) ||
      !Number.isFinite(params.p)
    ) {
      return false;
    }
    // Límites de coste: un hash manipulado en .env no debe poder bloquear el
    // proceso (scrypt con N/r/p enormes consume CPU y memoria sin límite).
    const powerOfTwo = params.N > 0 && (params.N & (params.N - 1)) === 0;
    if (!powerOfTwo || params.N < 4096 || params.N > 65536) return false;
    if (params.r < 1 || params.r > 16) return false;
    if (params.p < 1 || params.p > 4) return false;
    const salt = Buffer.from(saltB64, "base64url");
    const expected = Buffer.from(hashB64, "base64url");
    if (!salt.length || expected.length < 16 || expected.length > 64) return false;
    const derived = await scrypt(String(password), salt, expected.length, params);
    return timingSafeEqual(Buffer.from(derived), expected);
  } catch {
    return false;
  }
}

function hmac(secret, value) {
  return createHmac("sha256", secret).update(value).digest();
}

/**
 * Crea una sesión sin estado: payload firmado con HMAC.
 * Incluye un token CSRF para exigirlo en operaciones de escritura.
 */
export function createSession(secret, { ttlSeconds, now = Date.now() }) {
  const payload = {
    v: 1,
    sub: "owner",
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + ttlSeconds,
    csrf: randomBytes(18).toString("base64url"),
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(hmac(secret, body));
  return { token: `${body}.${sig}`, payload };
}

/** Verifica firma y caducidad. Devuelve el payload o null. */
export function verifySession(secret, token, now = Date.now()) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra) return null;
  const expected = hmac(secret, body);
  let provided;
  try {
    provided = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1 || payload.sub !== "owner") return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
  if (typeof payload.csrf !== "string" || payload.csrf.length < 16) return null;
  return payload;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const chunk of String(header).split(";")) {
    const index = chunk.indexOf("=");
    if (index < 1) continue;
    const name = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || "/"}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  return parts.join("; ");
}

/**
 * Comprueba que la petición viene del panel y porta el token CSRF de la sesión.
 * Se exige Origin (o Referer) además del token: defiende contra CSRF incluso
 * si SameSite cambiara de comportamiento en algún navegador.
 */
export function checkCsrf(req, payload, panelOrigin) {
  const header = req.headers["x-clouddesk-csrf"];
  if (typeof header !== "string" || header.length < 16) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(String(payload.csrf));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const origin = req.headers.origin;
  if (origin) return origin.replace(/\/+$/, "") === panelOrigin;
  const referer = req.headers.referer;
  if (referer) return referer.startsWith(`${panelOrigin}/`);
  return false;
}

/** Limitador de intentos de login por IP (ventana deslizante simple). */
export class LoginLimiter {
  constructor({ maxAttempts, windowMinutes, now = () => Date.now() }) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMinutes * 60_000;
    this.now = now;
    this.entries = new Map();
  }

  #entry(ip) {
    const current = this.entries.get(ip);
    const now = this.now();
    if (!current || current.resetAt <= now) {
      const fresh = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(ip, fresh);
      return fresh;
    }
    return current;
  }

  /** true si la IP puede intentar login; limpia entradas viejas. */
  allow(ip) {
    if (this.entries.size > 5000) {
      const now = this.now();
      for (const [key, entry] of this.entries) {
        if (entry.resetAt <= now) this.entries.delete(key);
      }
    }
    const entry = this.#entry(ip);
    return entry.count < this.maxAttempts;
  }

  retryAfterSeconds(ip) {
    const entry = this.#entry(ip);
    return Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000));
  }

  fail(ip) {
    this.#entry(ip).count += 1;
  }

  reset(ip) {
    this.entries.delete(ip);
  }
}
