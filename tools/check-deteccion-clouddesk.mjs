// Verifica que la web app de Apps Script (control de asistencia, bloqueo
// `soloPC`) reconozca el entorno de CloudDesk como un PC real, sin falsificar
// nada: se evalúa la función `esMovil()` del propio despliegue con los valores
// GENUINOS que reporta el Chromium del escritorio remoto (Debian + X11 +
// KasmVNC: ratón real, sin táctil, pantalla virtual 1280x720 o mayor).
//
// Uso:
//   node tools/check-deteccion-clouddesk.mjs
//   APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec \
//     node tools/check-deteccion-clouddesk.mjs
//
// Fuentes del userHtml, en orden: `apps-script-userhtml.html` ya decodificado,
// `apps-script.html` capturado, o descarga en vivo de APPS_SCRIPT_URL.
// Sale con código 0 solo si todos los casos "CloudDesk" pasan como PC y los
// casos de control (iPhone bloqueado, PC de oficina admitido) se cumplen.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const URL_DEFAULT =
  "https://script.google.com/macros/s/AKfycbxDwUu5WmusQUjMrMWYwecoWXWhBP2CehhRJt9c8qRaPRyVHALpr2SXaNDr3Y6zf4A/exec";
const ART = path.resolve("tests/.artifacts");
const ARCHIVO_CAPTURA = path.join(ART, "apps-script.html");
const ARCHIVO_USERHTML = path.join(ART, "apps-script-userhtml.html");

// --------------------------------------------------------------------------- #
// Carga del userHtml del despliegue
// --------------------------------------------------------------------------- #
// Convierte un literal de cadena JavaScript a texto JSON. Apps Script puede
// incrustar el JSON con escapes \xNN / \' (válidos en JS, no en JSON). Solo se
// usa como respaldo cuando JSON.parse directo falla.
function decodificarJsString(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\") { out += c; continue; }
    const n = raw[i + 1];
    if (n === undefined) { out += "\\"; continue; }
    switch (n) {
      case '"': out += '"'; i++; break;
      case "'": out += "'"; i++; break;
      case "\\": out += "\\"; i++; break;
      case "/": out += "/"; i++; break;
      case "b": out += "\b"; i++; break;
      case "f": out += "\f"; i++; break;
      case "n": out += "\n"; i++; break;
      case "r": out += "\r"; i++; break;
      case "t": out += "\t"; i++; break;
      case "x": {
        const code = Number.parseInt(raw.slice(i + 2, i + 4), 16);
        out += Number.isFinite(code) ? String.fromCharCode(code) : "";
        i += 3;
        break;
      }
      case "u": {
        const code = Number.parseInt(raw.slice(i + 2, i + 6), 16);
        out += Number.isFinite(code) ? String.fromCharCode(code) : "";
        i += 5;
        break;
      }
      default: out += n; i++; break;
    }
  }
  return out;
}

function decodificarUserHtml(html) {
  // goog.script.init("<JSON escapado como literal JS>") — escáner de string.
  const marca = 'goog.script.init("';
  const ini = html.indexOf(marca);
  if (ini === -1) throw new Error("la captura no contiene goog.script.init()");
  let i = ini + marca.length - 1; // comilla de apertura
  let interior = "";
  i++;
  for (; i < html.length; i++) {
    const c = html[i];
    if (c === "\\") { interior += c + html[i + 1]; i++; continue; }
    if (c === '"') break;
    interior += c;
  }
  let valor;
  try {
    valor = JSON.parse(interior);
  } catch {
    valor = JSON.parse(decodificarJsString(interior));
  }
  // El argumento de init puede venir doblemente codificado (string JSON) o
  // directamente como objeto: se normalizan ambos casos.
  if (typeof valor === "string") valor = JSON.parse(valor);
  return (valor && typeof valor === "object" && typeof valor.userHtml === "string")
    ? valor.userHtml
    : "";
}

async function cargarUserHtml() {
  await mkdir(ART, { recursive: true });
  try {
    const directo = await readFile(ARCHIVO_USERHTML, "utf8");
    if (directo.includes("function esMovil(")) return directo;
  } catch { /* sigue */ }
  try {
    const userHtml = decodificarUserHtml(await readFile(ARCHIVO_CAPTURA, "utf8"));
    if (userHtml) {
      await writeFile(ARCHIVO_USERHTML, userHtml);
      return userHtml;
    }
  } catch { /* sigue */ }
  const url = process.env.APPS_SCRIPT_URL || URL_DEFAULT;
  console.log(`Descargando despliegue en vivo: ${url}`);
  const respuesta = await fetch(url, { redirect: "follow" });
  if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status} al descargar ${url}`);
  const html = await respuesta.text();
  const userHtml = decodificarUserHtml(html);
  await writeFile(ARCHIVO_CAPTURA, html);
  await writeFile(ARCHIVO_USERHTML, userHtml);
  return userHtml;
}

// --------------------------------------------------------------------------- #
// Extracción de esMovil() del código real del despliegue
// --------------------------------------------------------------------------- #
function extraerEsMovil(userHtml) {
  const marca = "function esMovil(";
  const ini = userHtml.indexOf(marca);
  if (ini === -1) throw new Error("el despliegue no define function esMovil()");
  const abre = userHtml.indexOf("{", ini);
  let prof = 0;
  let fin = -1;
  for (let i = abre; i < userHtml.length; i++) {
    const c = userHtml[i];
    if (c === "{") prof++;
    else if (c === "}") { prof--; if (prof === 0) { fin = i + 1; break; } }
  }
  if (fin === -1) throw new Error("no se cerró la llave de esMovil()");
  const fuente = userHtml.slice(ini, fin);
  return { esMovil: new Function(`return (${fuente})`)(), fuente };
}

// --------------------------------------------------------------------------- #
// Entornos: los valores de CloudDesk son los que su Chromium reporta de verdad
// (launch-chromium.sh no pasa --user-agent ni flags táctiles; KasmVNC entrega
// eventos de ratón; el contenedor no tiene pantalla táctil).
// --------------------------------------------------------------------------- //
const UA_CHROMIUM_TRIXIE_X64 = // forma congelada (UA reduction) en Linux
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const UA_CHROMIUM_TRIXIE_ARM = // forma con arquitectura real en ARM64
  "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.181 Safari/537.36";

const RESOLUCIONES = [
  [1366, 768], [1280, 720], [1024, 768], [1600, 900], [1920, 1080],
];

function dispCloudDesk(ua, [sw, sh]) {
  return {
    ua,
    uaMobile: false,          // navigator.userAgentData.mobile en escritorio
    plataforma: "Linux",      // userAgentData.platform real en Linux
    coarse: false,            // sin (pointer: coarse): hay ratón vía KasmVNC
    finePointer: true,        // (any-pointer: fine) real en X11
    touch: 0,                 // sin pantalla táctil en el contenedor
    sw, sh,
  };
}

const CASOS = [];

for (const [sw, sh] of RESOLUCIONES) {
  CASOS.push({
    etiqueta: `CloudDesk Chromium Debian x64 · ${sw}x${sh}`,
    esperado: false, // PC: sin bloqueo
    disp: dispCloudDesk(UA_CHROMIUM_TRIXIE_X64, [sw, sh]),
  });
}
for (const [sw, sh] of RESOLUCIONES) {
  CASOS.push({
    etiqueta: `CloudDesk Chromium Debian ARM64 · ${sw}x${sh}`,
    esperado: false,
    disp: dispCloudDesk(UA_CHROMIUM_TRIXIE_ARM, [sw, sh]),
  });
}

// Controles de referencia: lo que pasa fuera de CloudDesk.
CASOS.push({
  etiqueta: "Control · PC de oficina Windows",
  esperado: false,
  disp: {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
    uaMobile: false, plataforma: "Windows", coarse: false, finePointer: true,
    touch: 0, sw: 1920, sh: 1080,
  },
});
CASOS.push({
  etiqueta: "Control · iPhone Safari (abrir directo en el celular)",
  esperado: true, // móvil: la app lo bloquea por diseño
  disp: {
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    uaMobile: true, plataforma: "iPhone", coarse: true, finePointer: false,
    touch: 5, sw: 390, sh: 844,
  },
});
// "Pedir sitio web de escritorio" de Safari cambia el UA a Macintosh, pero NO
// cambia maxTouchPoints (5), el puntero (coarse) ni la pantalla (390x844):
// esta app fue construida para detectar justo ese disfraz. En iOS ningún
// navegador puede falsear esos tres valores (WebKit los reporta tal cual).
CASOS.push({
  etiqueta: "Control · iPhone Safari 'sitio de escritorio' (UA Macintosh)",
  esperado: true, // sigue siendo móvil: táctil=5, puntero coarse, pantalla 390
  disp: {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    uaMobile: null, // Safari no implementa navigator.userAgentData
    plataforma: "iPhone", coarse: true, finePointer: false,
    touch: 5, sw: 390, sh: 844,
  },
});

// --------------------------------------------------------------------------- #
// Ejecución
// --------------------------------------------------------------------------- //
const userHtml = await cargarUserHtml();
const { esMovil } = extraerEsMovil(userHtml);

console.log("esMovil() extraído del despliegue real; evaluación por entorno:\n");
let fallos = 0;
for (const caso of CASOS) {
  const resultado = esMovil(caso.disp);
  const ok = resultado === caso.esperado;
  if (!ok) fallos++;
  const veredicto = resultado ? "MÓVIL → bloqueo 'Solo desde PC'" : "PC → acceso normal";
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${caso.etiqueta.padEnd(55)} ${veredicto}`,
  );
}

const resumen = {
  clouddeskPasaComoPC: fallos === 0,
  casos: CASOS.length,
  conBloqueoPorDispositivo: CASOS.filter((c) => c.esperado).length,
};
console.log("\n" + JSON.stringify(resumen));
process.exitCode = fallos === 0 ? 0 : 1;
