// Servidor de desarrollo para el panel: sirve gateway/web y hace de proxy
// hacia el API local. Sustituye a nginx únicamente en el equipo de desarrollo.
//
// Uso: node api/tools/dev-proxy.mjs [puerto]
//   PROXY_TARGET=http://127.0.0.1:18080  (por defecto)
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../../gateway/web");
const port = Number(process.argv[2] || 8088);
const host = process.env.HOST || "127.0.0.1";
const target = new URL(process.env.PROXY_TARGET || "http://127.0.0.1:18080");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const VNC_MOCK = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KasmVNC simulado</title>
<style>
  :root{color-scheme:dark}
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;background:
    radial-gradient(1200px 600px at 20% 0%,#12263a,#05080f 60%);
    color:#dbe7f3;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    text-align:center;padding:24px}
  .card{max-width:420px;border:1px solid #1e3348;border-radius:16px;padding:28px;
    background:#0a1420cc;box-shadow:0 20px 60px #0008}
  .tag{display:inline-block;font-size:11px;letter-spacing:.14em;text-transform:uppercase;
    color:#5eead4;border:1px solid #134e4a;background:#042f2e;border-radius:999px;padding:4px 10px}
  h1{font-size:20px;margin:14px 0 8px}
  p{color:#94a3b8;margin:8px 0}
  code{background:#111d2b;border:1px solid #1e3348;border-radius:6px;padding:2px 6px;color:#cbd5e1}
</style></head>
<body><div class="card">
  <span class="tag">Solo desarrollo</span>
  <h1>KasmVNC simulado</h1>
  <p>Esta página sustituye al escritorio real en el entorno local.
     No hay ningún escritorio remoto detrás.</p>
  <p>En producción el iframe carga <code>https://vnc.tudominio/</code>
     servido por KasmVNC y autenticado por nginx.</p>
</div></body></html>`;

function send(res, code, headers, body) {
  res.writeHead(code, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, { "Content-Type": "text/plain" }, "bad request\n");
  }
  if (relative === "/") relative = "/index.html";
  const filePath = path.resolve(webRoot, `.${relative}`);
  if (filePath !== webRoot && !filePath.startsWith(webRoot + path.sep)) {
    return send(res, 403, { "Content-Type": "text/plain" }, "forbidden\n");
  }
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "404\n");
  }
  if (!info.isFile()) {
    return send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "404\n");
  }
  const body = await readFile(filePath);
  const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function proxy(req, res) {
  const proxyReq = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: target.host },
      timeout: 90_000,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("timeout", () => proxyReq.destroy(new Error("timeout")));
  proxyReq.on("error", (error) => {
    if (!res.headersSent) {
      send(
        res,
        502,
        { "Content-Type": "application/json; charset=utf-8" },
        JSON.stringify({ error: { code: "proxy", message: `API no disponible: ${error.message}` } }),
      );
    } else {
      res.destroy();
    }
  });
  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://dev").pathname;
  if (pathname === "/vnc-mock") {
    return send(res, 200, { "Content-Type": "text/html; charset=utf-8" }, VNC_MOCK);
  }
  if (pathname.startsWith("/api/")) return proxy(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, { "Content-Type": "text/plain" }, "method not allowed\n");
  }
  serveStatic(req, res, pathname).catch((error) => {
    process.stderr.write(`[dev-proxy] ${error.stack}\n`);
    if (!res.headersSent) send(res, 500, { "Content-Type": "text/plain" }, "error\n");
  });
});

server.listen(port, host, () => {
  process.stdout.write(`[dev-proxy] http://${host}:${port} -> ${target.origin}\n`);
});
