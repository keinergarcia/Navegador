// Agente simulado para pruebas locales y para el modo de desarrollo del panel.
// Uso: node tools/mock-agent.mjs [puerto]
import http from "node:http";
import process from "node:process";

const port = Number(process.argv[2] || 18099);
const token = process.env.AGENT_TOKEN || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
let state = "running";
let resolution = { width: 1366, height: 768 };
let restarts = 0;

function json(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (path === "/health") return json(res, 200, { ok: true });
  if (req.headers["x-clouddesk-token"] !== token) {
    return json(res, 401, { error: "unauthorized" });
  }
  if (path === "/status") {
    return json(res, 200, {
      ok: true,
      session: { state, supervisorState: state.toUpperCase(), pid: 4242, uptimeSeconds: 83, resolution, connections: 0 },
      chromium: { processes: 9, rssMb: 412.5 },
      cpu: { cores: 2, load1: 0.42, usageUsec: 12345678 },
      memory: { usedMb: 2140, limitMb: 8192, hostTotalMb: 11800, hostAvailableMb: 8100 },
      disk: { usedMb: 18300, totalMb: 48000, percent: 38.1 },
      idle: { stopAfterMinutes: 30, idleForSeconds: 12 },
      systemUptimeSeconds: 86400,
      now: Math.floor(Date.now() / 1000),
      restarts,
    });
  }
  if (path === "/heartbeat" || path === "/session/start" || path === "/session/stop" || path === "/session/restart") {
    if (path === "/session/start") state = "running";
    if (path === "/session/stop") state = "stopped";
    if (path === "/session/restart") { restarts += 1; state = "running"; }
    return json(res, 200, { ok: true, action: path.split("/").pop() });
  }
  if (path === "/session/resolution") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        resolution = { width: Number(data.width), height: Number(data.height) };
        json(res, 200, { ok: true, resolution });
      } catch {
        json(res, 400, { error: "invalid_body" });
      }
    });
    return;
  }
  json(res, 404, { error: "not_found" });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`[mock-agent] http://127.0.0.1:${port}\n`);
});
