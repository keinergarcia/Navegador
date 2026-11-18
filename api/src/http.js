// Utilidades HTTP mínimas (sin framework).
export function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

export function sendEmpty(res, status, headers = {}) {
  res.writeHead(status, {
    "Content-Length": 0,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end();
}

export async function readJsonBody(req, limit = 8192) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("body_too_large");
      error.code = "body_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    const error = new Error("invalid_json");
    error.code = "invalid_json";
    throw error;
  }
}

/** IP del cliente tal y como la fija nginx (X-Real-IP). */
export function clientIp(req) {
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.length < 64) return real.trim();
  return (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

export function logRequest(req, res, startedAt) {
  const ms = Date.now() - startedAt;
  const ip = clientIp(req);
  const path = (req.url || "").split("?")[0];
  process.stdout.write(
    `${new Date().toISOString()} ${ip} ${req.method} ${path} ${res.statusCode} ${ms}ms\n`,
  );
}
