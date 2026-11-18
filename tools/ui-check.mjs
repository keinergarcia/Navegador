// Verificación visual con Chromium headless en dos anchos: 390x844 (iPhone)
// y 1280x900 (escritorio). Requiere el entorno de `make dev` en marcha.
//
// Uso:
//   node tools/ui-check.mjs
//   CHROME=/ruta/a/chrome BASE=http://127.0.0.1:8088 node tools/ui-check.mjs
//
// Guarda capturas en tests/.artifacts/ e imprime un JSON con el resultado.
// No es Safari: comprueba el layout y el flujo, no las peculiaridades de WebKit.
import { spawn } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const CANDIDATES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const BASE = (process.env.BASE || "http://127.0.0.1:8088").replace(/\/+$/, "");
const PASSWORD = process.env.PASSWORD || "clouddesk-dev-password";
const OUT = path.resolve(process.env.OUT || "tests/.artifacts");
const PORT = Number(process.env.CDP_PORT || 9333);
const PROFILE = path.join(OUT, "chrome-profile");

let chromePath = null;
for (const candidate of CANDIDATES) {
  try {
    await access(candidate);
    chromePath = candidate;
    break;
  } catch {
    // siguiente
  }
}
if (!chromePath) {
  console.error("No se encontró Chrome/Chromium. Define CHROME=/ruta/al/binario.");
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
await rm(PROFILE, { recursive: true, force: true });

const chrome = spawn(chromePath, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitPort() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return;
    } catch {
      // aún arrancando
    }
    await sleep(250);
  }
  throw new Error("Chrome no abrió el puerto de depuración");
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  async open() {
    if (this.ws.readyState === 1) return;
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "evaluate falló");
  return result.result.value;
}

async function waitFor(cdp, text, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `document.body.innerText.includes(${JSON.stringify(text)})`)) return true;
    await sleep(300);
  }
  return false;
}

async function shot(cdp, name, full = false) {
  const params = { format: "png", captureBeyondViewport: full };
  if (full) {
    const { cssContentSize } = await cdp.send("Page.getLayoutMetrics");
    params.clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
  }
  const { data } = await cdp.send("Page.captureScreenshot", params);
  const file = path.join(OUT, name);
  await writeFile(file, Buffer.from(data, "base64"));
  return file;
}

const consoleErrors = [];

try {
  await waitPort();
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = targets.find((entry) => entry.type === "page");
  if (!target) throw new Error("Chrome no expuso ninguna pestaña");

  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  cdp.ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(msg.params.exceptionDetails?.text || "exception");
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      consoleErrors.push(msg.params.entry.text);
    }
  });

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

  await cdp.send("Page.navigate", { url: `${BASE}/` });
  await sleep(1200);
  const loginShot = await shot(cdp, "mobile-01-login.png");

  await evaluate(cdp, `
    const input = document.querySelector("#password");
    input.value = ${JSON.stringify(PASSWORD)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#login-form").requestSubmit();
  `);
  const loggedIn = await waitFor(cdp, "Escritorio listo");
  await sleep(7000); // segunda muestra de CPU
  const panelShot = await shot(cdp, "mobile-02-panel.png");
  const panelFull = await shot(cdp, "mobile-02-panel-full.png", true);
  const metrics = await evaluate(
    cdp,
    `({innerWidth, innerHeight, dpr: devicePixelRatio, scrollWidth: document.documentElement.scrollWidth})`,
  );
  const overflow = await evaluate(cdp, "document.documentElement.scrollWidth > innerWidth");

  await cdp.send("Page.navigate", { url: `${BASE}/desktop.html` });
  await sleep(2500);
  const viewerShot = await shot(cdp, "mobile-03-visor.png");
  const viewerText = await evaluate(cdp, "document.body.innerText.slice(0, 400)");

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp.send("Page.navigate", { url: `${BASE}/` });
  await sleep(1500);
  const desktopShot = await shot(cdp, "desktop-01-panel.png");

  console.log(JSON.stringify({
    ok: true,
    loggedIn,
    metrics,
    overflow,
    consoleErrors,
    files: { loginShot, panelShot, panelFull, viewerShot, desktopShot },
    viewerText,
  }, null, 2));
  if (!loggedIn || overflow || consoleErrors.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(500);
}
