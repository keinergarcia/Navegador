// Cliente del agente del escritorio.
import { config } from "./config.js";

export class AgentError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "AgentError";
    this.status = status;
  }
}

async function call(path, { method = "GET", body, timeoutMs = 8000 } = {}) {
  const url = `${config.agentUrl}${path}`;
  try {
    const response = await fetch(url, {
      method,
      headers: {
        "X-CloudDesk-Token": config.agentToken,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 300) };
      }
    }
    if (!response.ok) {
      throw new AgentError(data.error || `agent_http_${response.status}`, response.status);
    }
    return data;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new AgentError("agent_timeout", 504);
    }
    throw new AgentError(`agent_unreachable: ${error.message}`, 502);
  }
}

export const agent = {
  status: () => call("/status", { timeoutMs: 6000 }),
  start: () => call("/session/start", { method: "POST", timeoutMs: 50000 }),
  stop: () => call("/session/stop", { method: "POST", timeoutMs: 50000 }),
  restart: () => call("/session/restart", { method: "POST", timeoutMs: 60000 }),
  setResolution: (width, height) =>
    call("/session/resolution", {
      method: "POST",
      body: { width, height },
      timeoutMs: 60000,
    }),
  heartbeat: () => call("/heartbeat", { method: "POST", timeoutMs: 4000 }),
};
