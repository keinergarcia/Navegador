// Prueba end-to-end REAL del escritorio CloudDesk.
//
// Se conecta por CDP al Chromium que corre dentro del contenedor (X11 + XFCE,
// resolución real, ratón real) y comprueba:
//   1. Señales del navegador: userAgent, pointer, maxTouchPoints, pantalla.
//   2. Que la web app de Apps Script carga dentro del escritorio.
//   3. Que `esMovil()` del propio despliegue devuelve "PC" (false).
//   4. Que no aparece ningún aviso de bloqueo "Solo desde PC".
//   5. Captura de pantalla como evidencia.
//
// No falsifica nada: lee los valores que reporta el navegador real. El bloqueo
// móvil de la app sigue intacto; esto solo demuestra que un escritorio Linux
// auténtico no se detecta como móvil.
//
// Requisitos:
//   - Escritorio arrancado con CDP habilitado:
//       docker compose -f docker-compose.yml -f docker-compose.e2e.yml \
//         up -d --force-recreate desktop
//   - Puerto 9222 accesible en 127.0.0.1 (el override lo publica solo ahí).
//
// Uso:
//   node tools/e2e-desktop.mjs
//   node tools/e2e-desktop.mjs --url "https://script.google.com/macros/s/.../exec"
//   node tools/e2e-desktop.mjs --cdp http://127.0.0.1:9222 --out tests/.artifacts
//   node tools/e2e-desktop.mjs --selftest     # valida la herramienta con Chrome local
//
// Códigos de salida: 0 verificado · 1 fallo · 2 pendiente (app no cargada/login)
import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULTS = {
  url: "https://script.google.com/macros/s/AKfycbxDwUu5WmusQUjMrMWYwecoWXWhBP2CehhRJt9c8qRaPRyVHALpr2SXaNDr3Y6zf4A/exec",
  cdp: "http://127.0.0.1:9222",
  out: "tests/.artifacts",
};

function parseArgs(argv) {
  const args = { ...DEFAULTS, selftest: false, timeout: 60_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--selftest") args.selftest = true;
    else if (item === "--url") args.url = argv[++i];
    else if (item === "--cdp") args.cdp = argv[++i];
    else if (item === "--out") args.out = argv[++i];
    else if (item === "--timeout") args.timeout = Number(argv[++i]) * 1000;
    else if (item === "-h" || item === "--help") {
      console.log(
        "uso: node tools/e2e-desktop.mjs [--cdp URL] [--url URL] [--out DIR] [--timeout S] [--selftest]",
      );
      process.exit(0);
    } else {
      console.error(`opción desconocida: ${item}`);
      process.exit(1);
    }
  }
  if (!Number.isFinite(args.timeout) || args.timeout < 5000) args.timeout = 60_000;
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------------------- //
// Cliente CDP mínimo (WebSocket nativo de Node >= 22)
// --------------------------------------------------------------------------- //
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
  }

  async open() {
    if (this.ws.readyState === 1) return;
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("WebSocket CDP rechazado")), {
        once: true,
      });
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ya cerrado
    }
  }
}

async function evaluate(cdp, expression, contextId) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    contextId,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "evaluate falló");
  return result.result?.value;
}

// --------------------------------------------------------------------------- //
// Señales del navegador y evaluación de esMovil()
// --------------------------------------------------------------------------- //
const ENV_EXPR = `(() => ({
  ua: navigator.userAgent,
  uaMobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
  plataforma: navigator.userAgentData ? navigator.userAgentData.platform : navigator.platform,
  touch: navigator.maxTouchPoints,
  coarse: matchMedia("(pointer: coarse)").matches,
  finePointer: matchMedia("(any-pointer: fine)").matches,
  sw: screen.width,
  sh: screen.height,
  iw: innerWidth,
  ih: innerHeight,
  dpr: devicePixelRatio,
  visible: document.visibilityState
}))()`;

const ES_MOVIL_EXPR = (env) => `(() => {
  if (typeof esMovil !== "function") return null;
  return esMovil(${JSON.stringify({
    ua: env.ua,
    uaMobile: env.uaMobile,
    plataforma: env.plataforma,
    coarse: env.coarse,
    finePointer: env.finePointer,
    touch: env.touch,
    sw: env.sw,
    sh: env.sh,
  })});
})()`;

const BLOCK_PATTERNS = [
  /solo\s+desde\s+(un\s+)?pc/i,
  /solo\s+pc/i,
  /solo\s+(se\s+)?(permite|puede)\s+(acceder\s+)?desde\s+(un\s+)?(ordenador|pc|computador)/i,
  /dispositivo\s+m[oó]vil\s+(no|bloquead)/i,
  /acceso\s+bloqueado.*m[oó]vil/i,
];

function findBlock(text) {
  for (const re of BLOCK_PATTERNS) {
    const match = text.match(re);
    if (match) return match[0];
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Conexión al navegador
// --------------------------------------------------------------------------- //
async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
}

async function waitCdp(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetchJson(`${base}/json/version`);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`CDP no responde en ${base}. ¿Está el escritorio con CLOUDDESK_E2E_DEBUG=1?`);
}

async function openTarget(base, url) {
  try {
    const target = await fetchJson(`${base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    return { target, created: true };
  } catch {
    const list = await fetchJson(`${base}/json/list`);
    const page = list.find((item) => item.type === "page");
    if (!page) throw new Error("el navegador no tiene ninguna pestaña");
    return { target: page, created: false };
  }
}

async function collectContexts(cdp) {
  const contexts = new Map();
  cdp.on("Runtime.executionContextCreated", ({ context }) => {
    contexts.set(context.id, context);
  });
  cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
    contexts.delete(executionContextId);
  });
  await cdp.send("Runtime.enable");
  await sleep(700);
  return contexts;
}

// --------------------------------------------------------------------------- //
// Comprobación principal sobre una pestaña ya conectada
// --------------------------------------------------------------------------- //
async function inspect(cdp, { strictEnv, outDir, label }) {
  const findings = { env: null, esMovil: [], alertas: [], contexto: [], captura: null };

  await cdp.send("Page.enable");
  const contexts = await collectContexts(cdp);

  // Contexto principal = el de la pestaña (sin auxData.frameId padre).
  const mainContext = [...contexts.values()].find((ctx) => ctx.auxData?.isDefault) || null;
  const mainId = mainContext?.id;

  findings.env = await evaluate(cdp, ENV_EXPR, mainId);
  const env = findings.env;

  if (strictEnv) {
    const fallos = [];
    if (env.touch !== 0) fallos.push(`maxTouchPoints=${env.touch}`);
    if (env.coarse) fallos.push("(pointer: coarse)");
    if (!env.finePointer) fallos.push("sin (any-pointer: fine)");
    if (env.uaMobile === true) fallos.push("userAgentData.mobile=true");
    if (env.sw < 1024 || env.sh < 600) fallos.push(`pantalla ${env.sw}x${env.sh}`);
    if (fallos.length) {
      throw new Error(`el navegador no parece un escritorio real: ${fallos.join(", ")}`);
    }
  }

  // Recorre todos los contextos (incluido el iframe del userHtml de Apps Script).
  for (const ctx of contexts.values()) {
    const origin = ctx.origin || "?";
    let text = "";
    let movil = null;
    try {
      text = await evaluate(
        cdp,
        "document.body ? String(document.body.innerText || document.body.textContent || '').slice(0, 4000) : ''",
        ctx.id,
      );
    } catch {
      continue; // contextos sin DOM (workers, etc.)
    }
    try {
      movil = await evaluate(cdp, ES_MOVIL_EXPR(env), ctx.id);
    } catch {
      movil = null;
    }
    if (typeof movil === "boolean") findings.esMovil.push({ origin, valor: movil });
    const bloqueo = text ? findBlock(text) : null;
    if (bloqueo) findings.alertas.push({ origin, texto: bloqueo });
    findings.contexto.push({ origin, chars: (text || "").length, movil });
  }

  // Evidencia visual.
  try {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    await mkdir(outDir, { recursive: true });
    const file = path.join(outDir, `e2e-escritorio-${label}.png`);
    await writeFile(file, Buffer.from(data, "base64"));
    findings.captura = file;
  } catch {
    findings.captura = null;
  }

  return findings;
}

function verdict(findings) {
  if (findings.alertas.length > 0) return { code: 1, estado: "BLOQUEADO" };
  if (findings.esMovil.some((item) => item.valor === true)) return { code: 1, estado: "MOVIL" };
  if (findings.esMovil.some((item) => item.valor === false)) return { code: 0, estado: "PC" };
  return { code: 2, estado: "PENDIENTE" };
}

// --------------------------------------------------------------------------- //
// Autoprueba: valida la herramienta con un Chrome local y una página fixture
// --------------------------------------------------------------------------- //
function chromeCandidates() {
  return [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
}

async function selftest(args) {
  let chromePath = null;
  for (const candidate of chromeCandidates()) {
    try {
      await access(candidate);
      chromePath = candidate;
      break;
    } catch {
      // siguiente
    }
  }
  if (!chromePath) {
    console.error("selftest: no se encontró Chrome/Chromium (define CHROME=...)");
    return 3;
  }

  const port = Number(process.env.CDP_PORT || 9444);
  const profile = path.resolve(args.out, "e2e-selftest-profile");
  const fixture = path
    .resolve(import.meta.dirname, "..", "tests", "fixtures", "e2e-app.html")
    .replace(/\\/g, "/");

  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--allow-file-access-from-files",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    await waitCdp(`http://127.0.0.1:${port}`, 20_000);

    const run = async (blocked) => {
      const url = `file:///${fixture.replace(/^\//, "")}?blocked=${blocked ? 1 : 0}`;
      const { target } = await openTarget(`http://127.0.0.1:${port}`, url);
      const cdp = new Cdp(target.webSocketDebuggerUrl);
      await cdp.open();
      // Chrome headless reporta 800x600 por defecto; se emula el tamaño real
      // del escritorio para que la fixture no lo confunda con un móvil.
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1366,
        height: 768,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: 1366,
        screenHeight: 768,
      });
      await cdp.send("Page.navigate", { url });
      await sleep(1200);
      const findings = await inspect(cdp, {
        strictEnv: false,
        outDir: path.resolve(args.out),
        label: blocked ? "selftest-bloqueado" : "selftest-pc",
      });
      const result = verdict(findings);
      cdp.close();
      return { result, findings };
    };

    const permitido = await run(false);
    const bloqueado = await run(true);

    const ok1 = permitido.result.code === 0;
    const ok2 = bloqueado.result.code === 1 && bloqueado.findings.alertas.length > 0;
    const resumen = {
      ok: ok1 && ok2,
      casoPC: permitido.result,
      casoBloqueado: {
        ...bloqueado.result,
        alerta: bloqueado.findings.alertas[0]?.texto || null,
      },
    };
    console.log(JSON.stringify(resumen, null, 2));
    return ok1 && ok2 ? 0 : 1;
  } finally {
    chrome.kill();
    await sleep(300);
  }
}

// --------------------------------------------------------------------------- //
// main
// --------------------------------------------------------------------------- //
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) return selftest(args);

  const base = args.cdp.replace(/\/+$/, "");
  await waitCdp(base, args.timeout);

  const { target } = await openTarget(base, args.url);
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();

  try {
    await cdp.send("Page.navigate", { url: args.url });
    // Espera de carga: suficiente para Apps Script + iframe del userHtml.
    const deadline = Date.now() + Math.min(args.timeout, 30_000);
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const state = await evaluate(cdp, "document.readyState");
        if (state === "complete") {
          ready = true;
          break;
        }
      } catch {
        // aún cargando
      }
      await sleep(700);
    }
    await sleep(2500); // deja que el iframe del userHtml se monte

    const version = await fetchJson(`${base}/json/version`);
    const findings = await inspect(cdp, {
      strictEnv: true,
      outDir: path.resolve(args.out),
      label: new Date().toISOString().replace(/[:.]/g, "-"),
    });
    const result = verdict(findings);

    console.log(
      JSON.stringify(
        {
          ok: result.code === 0,
          estado: result.estado,
          navegador: version.Browser,
          url: args.url,
          cargada: ready,
          entorno: findings.env,
          esMovil: findings.esMovil,
          bloqueos: findings.alertas,
          captura: findings.captura,
          nota:
            result.code === 2
              ? "La app no expuso esMovil(): inicia sesión en el escritorio o revisa la URL."
              : undefined,
        },
        null,
        2,
      ),
    );
    return result.code;
  } finally {
    cdp.close();
  }
}

process.exitCode = await main().catch((error) => {
  console.error(`e2e: ${error.message}`);
  return 1;
});
