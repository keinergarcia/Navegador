import assert from "node:assert/strict";
import test from "node:test";

import {
  LoginLimiter,
  checkCsrf,
  createSession,
  hashPassword,
  parseCookies,
  serializeCookie,
  verifyPassword,
  verifySession,
} from "../src/auth.js";

test("hashPassword y verifyPassword", async () => {
  const hash = await hashPassword("contraseña-de-prueba-123");
  assert.match(hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(await verifyPassword("contraseña-de-prueba-123", hash), true);
  assert.equal(await verifyPassword("otra-contraseña", hash), false);
  assert.equal(await verifyPassword("contraseña-de-prueba-123", "basura"), false);
  assert.equal(await verifyPassword("contraseña-de-prueba-123", ""), false);
});

test("hashPassword rechaza contraseñas cortas", async () => {
  await assert.rejects(() => hashPassword("corta"));
});

test("verifyPassword rechaza parámetros scrypt abusivos", async () => {
  const sal = Buffer.alloc(16, 1).toString("base64url");
  const hash = Buffer.alloc(32, 2).toString("base64url");
  // N no potencia de dos, N desmesurado, r/p fuera de rango y hash truncado.
  assert.equal(await verifyPassword("x", `scrypt$12345$8$1$${sal}$${hash}`), false);
  assert.equal(await verifyPassword("x", `scrypt$1048576$8$1$${sal}$${hash}`), false);
  assert.equal(await verifyPassword("x", `scrypt$16384$64$1$${sal}$${hash}`), false);
  assert.equal(await verifyPassword("x", `scrypt$16384$8$9$${sal}$${hash}`), false);
  assert.equal(await verifyPassword("x", `scrypt$16384$8$1$${sal}$AAAA`), false);
});

test("sesión firmada: ida y vuelta", () => {
  const secret = "a".repeat(64);
  const { token, payload } = createSession(secret, { ttlSeconds: 60 });
  const verified = verifySession(secret, token);
  assert.ok(verified);
  assert.equal(verified.csrf, payload.csrf);
});

test("sesión firmada: manipulación y caducidad", () => {
  const secret = "b".repeat(64);
  const { token } = createSession(secret, { ttlSeconds: 60 });
  const [body, sig] = token.split(".");
  assert.equal(verifySession(secret, `${body}.${sig.slice(0, -2)}xx`), null);
  assert.equal(verifySession("c".repeat(64), token), null);
  assert.equal(verifySession(secret, "no-es-un-token"), null);
  const expired = createSession(secret, { ttlSeconds: -10 });
  assert.equal(verifySession(secret, expired.token), null);
});

test("cookies", () => {
  const header = serializeCookie("cd_session", "abc.def", {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    domain: ".example.com",
    maxAge: 120,
  });
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /Domain=\.example\.com/);
  assert.deepEqual(parseCookies("a=1; cd_session=xyz; b=2"), {
    a: "1",
    cd_session: "xyz",
    b: "2",
  });
});

test("CSRF exige token y origen", () => {
  const payload = { csrf: "0123456789abcdef" };
  const base = { headers: { "x-clouddesk-csrf": payload.csrf, origin: "https://desk.example.com" } };
  assert.equal(checkCsrf(base, payload, "https://desk.example.com"), true);
  assert.equal(checkCsrf(base, payload, "https://otro.example.com"), false);
  assert.equal(
    checkCsrf({ headers: { "x-clouddesk-csrf": "otro-token-distinto" } }, payload, "https://desk.example.com"),
    false,
  );
  assert.equal(
    checkCsrf(
      { headers: { "x-clouddesk-csrf": payload.csrf, referer: "https://desk.example.com/app" } },
      payload,
      "https://desk.example.com",
    ),
    true,
  );
});

test("limitador de login", () => {
  let now = 1000;
  const limiter = new LoginLimiter({ maxAttempts: 2, windowMinutes: 1, now: () => now });
  assert.equal(limiter.allow("1.2.3.4"), true);
  limiter.fail("1.2.3.4");
  limiter.fail("1.2.3.4");
  assert.equal(limiter.allow("1.2.3.4"), false);
  assert.equal(limiter.allow("5.6.7.8"), true);
  now += 61_000;
  assert.equal(limiter.allow("1.2.3.4"), true);
});
