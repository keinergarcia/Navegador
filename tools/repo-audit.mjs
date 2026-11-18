// Auditoría estática del repositorio CloudDesk.
//
// Comprueba que están los archivos imprescindibles, que no se cuelan secretos
// ni artefactos pesados, que los hashes de KasmVNC están fijados y que las
// referencias entre scripts/workflows existen. No sustituye a las pruebas: es
// una red de seguridad para CI y para ejecutar antes de cada commit.
//
// Uso:
//   node tools/repo-audit.mjs            # informe legible
//   node tools/repo-audit.mjs --json     # salida para máquinas
//   node tools/repo-audit.mjs --strict   # falla también con avisos
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const JSON_OUT = process.argv.includes("--json");
const STRICT = process.argv.includes("--strict");

const problems = [];
const warnings = [];
const checks = [];

function ok(name, detail = "") {
  checks.push({ level: "ok", name, detail });
}
function fail(name, detail) {
  checks.push({ level: "fail", name, detail });
  problems.push(`${name}${detail ? `: ${detail}` : ""}`);
}
function warn(name, detail) {
  checks.push({ level: "warn", name, detail });
  warnings.push(`${name}${detail ? `: ${detail}` : ""}`);
}

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", ...options }).trim();
}

async function exists(rel) {
  try {
    await stat(path.join(ROOT, rel));
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------- //
// 1. Archivos imprescindibles
// --------------------------------------------------------------------------- //
const REQUIRED = [
  "README.md",
  "LICENSE",
  ".gitignore",
  ".gitattributes",
  ".env.example",
  "docker-compose.yml",
  "docker-compose.e2e.yml",
  "Makefile",
  "api/Dockerfile",
  "api/package.json",
  "api/src/server.js",
  "gateway/Dockerfile",
  "gateway/nginx/nginx.conf",
  "gateway/nginx/templates/default.conf.template",
  "desktop/Dockerfile",
  "desktop/rootfs/opt/clouddesk/entrypoint.sh",
  "desktop/rootfs/opt/clouddesk/agent.py",
  "scripts/bootstrap.sh",
  "scripts/provision-oracle.sh",
  "scripts/install-oracle.sh",
  "scripts/issue-cert.sh",
  "scripts/smoke-test.sh",
  "scripts/open-ports.sh",
  "scripts/install-docker.sh",
  "scripts/update.sh",
  "tools/check-deteccion-clouddesk.mjs",
  "tools/e2e-desktop.mjs",
  "tools/repo-audit.mjs",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  ".github/workflows/deploy.yml",
  "docs/AUDITORIA.md",
  "docs/DESPLIEGUE-ORACLE.md",
  "docs/CI-CD.md",
  "docs/SEGURIDAD.md",
  "docs/PRUEBA-E2E.md",
  "docs/CODESPACES.md",
];

for (const rel of REQUIRED) {
  if (await exists(rel)) ok(`existe ${rel}`);
  else fail(`falta ${rel}`);
}

// --------------------------------------------------------------------------- //
// 2. Secretos y artefactos en Git
// --------------------------------------------------------------------------- //
let tracked = [];
let inGit = false;
try {
  tracked = git(["ls-files"]).split("\n").filter(Boolean);
  inGit = true;
} catch {
  warn("git no disponible", "se omite la comprobación de archivos versionados");
}

const FORBIDDEN_TRACKED = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$)/,
  /(^|\/)data\//,
  /(^|\/)backups\//,
  /(^|\/)tests\/\.artifacts\//,
  /\.(tar\.gz|tgz|deb|pem|key|crt)$/,
  /(^|\/)__pycache__\//,
];

if (inGit) {
  for (const rel of tracked) {
    if (FORBIDDEN_TRACKED.some((re) => re.test(rel))) fail("archivo prohibido versionado", rel);
  }
  if (!problems.some((p) => p.startsWith("archivo prohibido"))) {
    ok(`sin archivos prohibidos (${tracked.length} versionados)`);
  }

  const SECRET_PATTERNS = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "clave privada"],
    [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "token de GitHub"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, "token fine-grained de GitHub"],
    [/\bAKIA[0-9A-Z]{16}\b/, "access key de AWS"],
    [/(?<![\\])AUTH_PASSWORD_HASH='scrypt\$/, "hash de contraseña real"],
    [/SESSION_SECRET='[0-9a-f]{32,}'/, "SESSION_SECRET real"],
    [/AGENT_TOKEN='[0-9a-f]{32,}'/, "AGENT_TOKEN real"],
    // `$VAR` es una referencia de shell, no un secreto.
    [/VNC_PASSWORD='(?!\$)[^']{12,}'/, "VNC_PASSWORD real"],
    [/VNC_AUTH_B64='[A-Za-z0-9+/=]{12,}'/, "VNC_AUTH_B64 real"],
  ];

  let leaks = 0;
  for (const rel of tracked) {
    if (rel === ".env.example" || rel.startsWith("docs/")) continue;
    let text;
    try {
      text = await readFile(path.join(ROOT, rel), "utf8");
    } catch {
      continue;
    }
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(text)) {
        leaks += 1;
        fail(`posible secreto (${label})`, rel);
      }
    }
  }
  if (leaks === 0) ok("sin credenciales en archivos versionados");

  const MAX_BYTES = 2 * 1024 * 1024;
  let big = 0;
  for (const rel of tracked) {
    try {
      const info = await stat(path.join(ROOT, rel));
      if (info.size > MAX_BYTES) {
        big += 1;
        fail("archivo versionado > 2 MB", `${rel} (${Math.round(info.size / 1024)} KB)`);
      }
    } catch {
      // archivo borrado del índice: irrelevante
    }
  }
  if (big === 0) ok("ningún archivo versionado supera 2 MB");
}

// --------------------------------------------------------------------------- //
// 3. KasmVNC: versión y hashes fijados
// --------------------------------------------------------------------------- //
const dockerfile = await readFile(path.join(ROOT, "desktop/Dockerfile"), "utf8");
const version = dockerfile.match(/^ARG KASMVNC_VERSION=(\d+\.\d+\.\d+)$/m)?.[1];
version ? ok(`KasmVNC fijado en ${version}`) : fail("KASMVNC_VERSION sin fijar");

for (const arch of ["ARM64", "AMD64"]) {
  const hash = dockerfile.match(new RegExp(`^ARG KASMVNC_SHA256_${arch}=([0-9a-f]{64})$`, "m"))?.[1];
  if (hash) ok(`SHA-256 ${arch} fijado (${hash.slice(0, 12)}…)`);
  else fail(`SHA-256 ${arch} ausente o inválido (no se debe desactivar la verificación)`);
}

// --------------------------------------------------------------------------- //
// 4. Referencias entre workflows y scripts
// --------------------------------------------------------------------------- //
const workflows = [
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  ".github/workflows/deploy.yml",
];
for (const wf of workflows) {
  if (!(await exists(wf))) continue;
  const text = await readFile(path.join(ROOT, wf), "utf8");
  const refs = [...text.matchAll(/(?:\.\/)?(scripts\/[A-Za-z0-9_.-]+|tools\/[A-Za-z0-9_.-]+)/g)]
    .map((m) => m[1]);
  for (const ref of new Set(refs)) {
    if (!(await exists(ref))) fail(`${wf} referencia un archivo inexistente`, ref);
  }
  if (wf.endsWith("deploy.yml") && !/\$\{\{\s*secrets\./.test(text)) {
    warn(`${wf} no usa secrets`, "el despliegue se omitirá hasta configurarlos");
  }
}

// --------------------------------------------------------------------------- //
// 5. Endurecimiento mínimo en compose
// --------------------------------------------------------------------------- //
const compose = await readFile(path.join(ROOT, "docker-compose.yml"), "utf8");
for (const [label, re] of [
  ["no-new-privileges en desktop", /no-new-privileges:true/],
  ["cap_drop ALL en api", /cap_drop:\s*\n\s*-\s*ALL/],
  ["healthcheck del escritorio", /8099\/health/],
  ["solo 80/443 publicados", /- "80:80"[\s\S]*- "443:443"/],
]) {
  if (re.test(compose)) ok(label);
  else fail(`compose: ${label}`);
}
if (/-\s*"?8444:8444"?/.test(compose)) fail("compose publica KasmVNC (8444) directamente");
if (/\/var\/run\/docker\.sock/.test(compose)) fail("compose monta el socket de Docker");

// --------------------------------------------------------------------------- //
// 6. Documentación mínima del README
// --------------------------------------------------------------------------- //
if (await exists("README.md")) {
  const readme = await readFile(path.join(ROOT, "README.md"), "utf8");
  for (const section of ["Arquitectura", "Oracle", "GitHub Actions", "HTTPS", "E2E"]) {
    if (readme.toLowerCase().includes(section.toLowerCase())) ok(`README cubre ${section}`);
    else warn(`README no menciona ${section}`);
  }
}

// --------------------------------------------------------------------------- //
// Informe
// --------------------------------------------------------------------------- //
const summary = {
  ok: problems.length === 0,
  problemas: problems.length,
  avisos: warnings.length,
  comprobaciones: checks.length,
  detalle: problems,
};

if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  for (const c of checks) {
    const tag = c.level === "ok" ? "ok  " : c.level === "warn" ? "aviso" : "FALLO";
    console.log(`${tag} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  console.log(
    `\n${problems.length === 0 ? "Auditoría correcta" : `Auditoría con ${problems.length} problemas`}` +
      ` · ${warnings.length} avisos · ${checks.length} comprobaciones`,
  );
}

process.exit(problems.length > 0 || (STRICT && warnings.length > 0) ? 1 : 0);
