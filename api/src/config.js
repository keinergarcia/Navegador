// Configuración del API. Falla al arrancar si falta un secreto o es inválido.
import process from "node:process";

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value.trim();
}

function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  }
  return value;
}

const passwordHash = required("AUTH_PASSWORD_HASH");
if (!/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(passwordHash)) {
  throw new Error(
    "AUTH_PASSWORD_HASH no tiene el formato esperado (scrypt$N$r$p$salt$hash). " +
      "Genera uno con scripts/set-password.sh",
  );
}

const sessionSecret = required("SESSION_SECRET");
if (sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET debe tener al menos 32 caracteres");
}

const agentToken = required("AGENT_TOKEN");
if (!/^[0-9a-fA-F]{32,}$/.test(agentToken)) {
  throw new Error("AGENT_TOKEN debe ser hexadecimal (mínimo 32 caracteres)");
}

export const config = {
  port: intEnv("PORT", 8080, 1, 65535),
  passwordHash,
  sessionSecret,
  agentToken,
  agentUrl: (process.env.AGENT_URL || "http://desktop:8099").replace(/\/+$/, ""),
  cookieName: "cd_session",
  cookieDomain: (process.env.COOKIE_DOMAIN || "").trim(),
  sessionHours: intEnv("SESSION_HOURS", 12, 1, 168),
  rememberDays: intEnv("REMEMBER_DAYS", 30, 1, 365),
  loginMaxAttempts: intEnv("LOGIN_MAX_ATTEMPTS", 5, 1, 100),
  loginWindowMinutes: intEnv("LOGIN_WINDOW_MINUTES", 15, 1, 1440),
  panelOrigin: (process.env.PANEL_ORIGIN || "").replace(/\/+$/, ""),
  vncUrl: (process.env.VNC_URL || "").trim(),
  vncHost: (process.env.VNC_HOST || "").trim(),
  secureCookies: process.env.INSECURE_COOKIES !== "1",
  version: process.env.APP_VERSION || "dev",
  isProduction: process.env.NODE_ENV === "production",
};
