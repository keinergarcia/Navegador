// CloudDesk - panel de control (JS sin dependencias, sin build).

const $ = (selector) => document.querySelector(selector);
const els = {
  loginView: $("#login-view"),
  appView: $("#app-view"),
  loginForm: $("#login-form"),
  password: $("#password"),
  remember: $("#remember"),
  loginBtn: $("#login-btn"),
  loginError: $("#login-error"),
  togglePassword: $("#toggle-password"),
  conn: $("#conn"),
  connText: $("#conn-text"),
  sessionTitle: $("#session-title"),
  sessionSub: $("#session-sub"),
  sessionPill: $("#session-pill"),
  openBtn: $("#open-desktop"),
  openLabel: $("#open-label"),
  metaResolution: $("#meta-resolution"),
  metaUptime: $("#meta-uptime"),
  metaConns: $("#meta-conns"),
  cpuValue: $("#cpu-value"),
  cpuBar: $("#cpu-bar"),
  cpuFoot: $("#cpu-foot"),
  memValue: $("#mem-value"),
  memBar: $("#mem-bar"),
  memFoot: $("#mem-foot"),
  diskValue: $("#disk-value"),
  diskBar: $("#disk-bar"),
  diskFoot: $("#disk-foot"),
  chromeValue: $("#chrome-value"),
  chromeBar: $("#chrome-bar"),
  chromeFoot: $("#chrome-foot"),
  presets: $("#presets"),
  resWidth: $("#res-width"),
  resHeight: $("#res-height"),
  resApply: $("#res-apply"),
  restart: $("#restart-session"),
  toggle: $("#toggle-session"),
  logout: $("#logout"),
  version: $("#version-label"),
  toast: $("#toast"),
};

const state = {
  csrf: null,
  status: null,
  busy: false,
  pollTimer: null,
  heartTimer: null,
  cpuSample: null,
  lastLatency: null,
  started: false,
};

class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

// --------------------------------------------------------------------- API
async function api(path, { method = "GET", body, csrf = true } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (csrf && state.csrf) headers["X-CloudDesk-CSRF"] = state.csrf;

  const started = performance.now();
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    setConnection("offline", "Sin conexión");
    throw new ApiError("No hay conexión con el servidor", 0);
  }
  state.lastLatency = Math.round(performance.now() - started);

  let data = {};
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }

  if (response.status === 401) {
    showLogin("La sesión ha caducado. Vuelve a entrar.");
    throw new ApiError("Sesión caducada", 401, data);
  }
  if (!response.ok) {
    const message = data?.error?.message || `Error ${response.status}`;
    throw new ApiError(message, response.status, data);
  }
  return data;
}

// -------------------------------------------------------------------- UI
function showLogin(message = "") {
  stopTimers();
  els.appView.hidden = true;
  els.loginView.hidden = false;
  if (message) showLoginError(message);
  els.password.focus({ preventScroll: true });
}

function showApp() {
  els.loginView.hidden = true;
  els.appView.hidden = false;
  if (!state.started) {
    state.started = true;
    startTimers();
    pollStatus();
  }
}

function showLoginError(message) {
  els.loginError.textContent = message;
  els.loginError.hidden = false;
}

function clearLoginError() {
  els.loginError.hidden = true;
  els.loginError.textContent = "";
}

let toastTimer = null;
function toast(message, kind = "info") {
  els.toast.textContent = message;
  els.toast.dataset.kind = kind;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, kind === "error" ? 6000 : 3200);
}

function setConnection(kind, label) {
  els.conn.dataset.state = kind;
  els.connText.textContent = label;
}

function setBusy(busy, label = "") {
  state.busy = busy;
  for (const button of [els.openBtn, els.restart, els.toggle, els.resApply]) {
    button.disabled = busy;
  }
  if (label) els.openLabel.textContent = label;
  else if (state.status?.session?.state === "running") els.openLabel.textContent = "Abrir escritorio";
  else els.openLabel.textContent = "Iniciar escritorio";
}

function fmtGb(mb) {
  if (!Number.isFinite(mb)) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function fmtUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

function fmtNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("es-ES", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

const STATE_LABEL = {
  running: "Activa",
  starting: "Iniciando",
  stopping: "Deteniendo",
  stopped: "Detenida",
  error: "Error",
  unknown: "Desconocida",
};

function renderStatus(data) {
  state.status = data;

  if (data.agentOnline === false) {
    setConnection("slow", "Agente sin respuesta");
    els.sessionPill.dataset.state = "error";
    els.sessionPill.textContent = "Sin agente";
    els.sessionTitle.textContent = "El escritorio no responde";
    els.sessionSub.textContent = "Comprueba el contenedor desktop en el servidor.";
    return;
  }

  setConnection(
    state.lastLatency !== null && state.lastLatency > 2500 ? "slow" : "online",
    `En línea · ${state.lastLatency ?? "—"} ms`,
  );

  const session = data.session || {};
  const resolution = session.resolution || {};
  const running = session.state === "running";

  els.sessionPill.dataset.state = session.state || "unknown";
  els.sessionPill.textContent = STATE_LABEL[session.state] || "—";

  els.sessionTitle.textContent = running ? "Escritorio listo" : "Escritorio detenido";
  els.sessionSub.textContent = running
    ? `XFCE · Chromium · ${resolution.width}×${resolution.height}`
    : "Arranca la sesión para abrir Chromium.";

  els.metaResolution.textContent = resolution.width ? `${resolution.width}×${resolution.height}` : "—";
  els.metaUptime.textContent = running ? fmtUptime(session.uptimeSeconds) : "—";
  els.metaConns.textContent = running ? String(session.connections ?? 0) : "—";

  // CPU: derivada del tiempo de CPU del cgroup entre muestras.
  const usage = data.cpu?.usageUsec;
  const now = data.panel?.now ?? Date.now();
  const cores = data.cpu?.cores || 2;
  if (Number.isFinite(usage)) {
    if (state.cpuSample && now > state.cpuSample.now) {
      const deltaCpuMs = (usage - state.cpuSample.usage) / 1000;
      const deltaWallMs = now - state.cpuSample.now;
      const percent = Math.max(0, Math.min(100, (deltaCpuMs / deltaWallMs / cores) * 100));
      els.cpuValue.textContent = `${percent.toFixed(0)}%`;
      els.cpuBar.style.width = `${percent.toFixed(1)}%`;
    }
    state.cpuSample = { usage, now };
  }
  els.cpuFoot.textContent = `${cores} OCPU · carga ${fmtNumber(data.cpu?.load1, 2)}`;

  // Memoria.
  const mem = data.memory || {};
  const memPercent = Number.isFinite(mem.usedMb) && Number.isFinite(mem.limitMb) && mem.limitMb > 0
    ? Math.min(100, (mem.usedMb / mem.limitMb) * 100)
    : 0;
  els.memValue.textContent = fmtGb(mem.usedMb);
  els.memBar.style.width = `${memPercent.toFixed(1)}%`;
  els.memFoot.textContent = `límite ${fmtGb(mem.limitMb)} · host ${fmtGb(mem.hostAvailableMb)} libres`;

  // Disco.
  const disk = data.disk || {};
  els.diskValue.textContent = Number.isFinite(disk.percent) ? `${disk.percent.toFixed(0)}%` : "—";
  els.diskBar.style.width = `${Number.isFinite(disk.percent) ? Math.min(100, disk.percent) : 0}%`;
  els.diskFoot.textContent = `${fmtGb(disk.usedMb)} de ${fmtGb(disk.totalMb)}`;

  // Chromium.
  const chrome = data.chromium || {};
  els.chromeValue.textContent = chrome.processes ? `${chrome.processes}` : "0";
  els.chromeBar.style.width = `${Math.min(100, ((chrome.processes || 0) / 24) * 100)}%`;
  els.chromeFoot.textContent = chrome.processes
    ? `${chrome.processes} procesos · ${fmtGb(chrome.rssMb)}`
    : "sin procesos activos";

  // Selector de resolución.
  renderPresets(data.presets || [], resolution);
  els.toggle.textContent = running ? "Detener" : "Iniciar";
  if (!state.busy) setBusy(false);
}

function renderPresets(presets, current) {
  const fragment = document.createDocumentFragment();
  const seen = new Set();
  for (const preset of presets) {
    const key = `${preset.width}x${preset.height}`;
    seen.add(key);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.dataset.width = String(preset.width);
    button.dataset.height = String(preset.height);
    button.textContent = `${preset.width} × ${preset.height}`;
    button.title = preset.label;
    const active = current.width === preset.width && current.height === preset.height;
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.addEventListener("click", () => applyResolution(preset.width, preset.height));
    fragment.append(button);
  }
  if (current.width && !seen.has(`${current.width}x${current.height}`)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = `${current.width} × ${current.height}`;
    button.setAttribute("aria-pressed", "true");
    button.disabled = true;
    fragment.append(button);
  }
  els.presets.replaceChildren(fragment);
  if (current.width) {
    els.resWidth.value = String(current.width);
    els.resHeight.value = String(current.height);
  }
}

// ---------------------------------------------------------------- actions
async function pollStatus() {
  if (document.visibilityState === "hidden") return;
  try {
    const data = await api("/api/status");
    renderStatus(data);
  } catch (error) {
    if (error.status !== 401) {
      setConnection("offline", "Sin conexión");
      if (!els.appView.hidden) toast(error.message, "error");
    }
  }
}

async function waitForState(target, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    try {
      const data = await api("/api/status");
      renderStatus(data);
      const current = data.session?.state;
      if (current === target) return true;
      if (current === "error") return false;
    } catch {
      // seguir intentando
    }
  }
  return false;
}

async function ensureRunning() {
  const current = state.status?.session?.state;
  if (current === "running") return true;
  if (state.busy) return false;
  setBusy(true, "Iniciando…");
  try {
    await api("/api/session/start", { method: "POST" });
    const ok = await waitForState("running");
    if (!ok) toast("La sesión no arrancó a tiempo. Revisa los registros.", "error");
    return ok;
  } finally {
    setBusy(false);
  }
}

async function openDesktop() {
  if (state.busy) return;
  const ok = await ensureRunning();
  if (!ok) return;
  window.location.href = "/desktop.html";
}

async function restartSession() {
  if (state.busy) return;
  if (!window.confirm("Se reiniciará el escritorio y se cerrarán las aplicaciones abiertas. ¿Continuar?")) {
    return;
  }
  setBusy(true, "Reiniciando…");
  try {
    await api("/api/session/restart", { method: "POST" });
    const ok = await waitForState("running");
    toast(ok ? "Sesión reiniciada" : "El reinicio tardó más de lo esperado", ok ? "info" : "error");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function toggleSession() {
  if (state.busy) return;
  const running = state.status?.session?.state === "running";
  if (running && !window.confirm("Se detendrá la sesión y se cerrarán las aplicaciones. El perfil se conserva. ¿Continuar?")) {
    return;
  }
  setBusy(true, running ? "Deteniendo…" : "Iniciando…");
  try {
    await api(`/api/session/${running ? "stop" : "start"}`, { method: "POST" });
    const ok = await waitForState(running ? "stopped" : "running");
    toast(ok ? (running ? "Sesión detenida" : "Sesión iniciada") : "La operación tardó más de lo esperado", ok ? "info" : "error");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function applyResolution(width, height) {
  if (state.busy) return;
  const valid =
    Number.isInteger(width) && Number.isInteger(height) &&
    width >= 640 && width <= 1920 && height >= 360 && height <= 1200 &&
    width % 2 === 0 && height % 2 === 0;
  if (!valid) {
    toast("Resolución no válida (640–1920 × 360–1200, cifras pares)", "error");
    return;
  }
  if (!window.confirm(`Se reiniciará la sesión a ${width}×${height}. ¿Continuar?`)) return;
  setBusy(true, "Aplicando…");
  try {
    await api("/api/session/resolution", { method: "POST", body: { width, height } });
    await waitForState("running");
    toast(`Resolución cambiada a ${width}×${height}`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST", csrf: false });
  } catch {
    // aunque falle, recargamos
  }
  window.location.replace("/");
}

// ------------------------------------------------------------------ timers
function startTimers() {
  stopTimers();
  state.pollTimer = setInterval(pollStatus, 6000);
  state.heartTimer = setInterval(() => {
    if (document.visibilityState === "hidden" || !state.csrf) return;
    api("/api/heartbeat", { method: "POST" }).catch(() => {});
  }, 45000);
}

function stopTimers() {
  clearInterval(state.pollTimer);
  clearInterval(state.heartTimer);
  state.pollTimer = null;
  state.heartTimer = null;
}

// ------------------------------------------------------------------ events
els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearLoginError();
  const password = els.password.value;
  if (password.length < 12) {
    showLoginError("La contraseña debe tener al menos 12 caracteres.");
    return;
  }
  els.loginBtn.disabled = true;
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: { password, remember: els.remember.checked },
      csrf: false,
    });
    state.csrf = data.csrf;
    els.password.value = "";
    showApp();
    toast("Sesión iniciada");
  } catch (error) {
    showLoginError(error.message || "No se pudo iniciar sesión");
    els.password.select();
  } finally {
    els.loginBtn.disabled = false;
  }
});

els.togglePassword.addEventListener("click", () => {
  const visible = els.password.type === "text";
  els.password.type = visible ? "password" : "text";
  els.togglePassword.setAttribute("aria-pressed", String(!visible));
  els.togglePassword.setAttribute("aria-label", visible ? "Mostrar contraseña" : "Ocultar contraseña");
  els.password.focus({ preventScroll: true });
});

els.openBtn.addEventListener("click", openDesktop);
els.restart.addEventListener("click", restartSession);
els.toggle.addEventListener("click", toggleSession);
els.logout.addEventListener("click", logout);
els.resApply.addEventListener("click", () => {
  applyResolution(Number(els.resWidth.value), Number(els.resHeight.value));
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.csrf && !els.appView.hidden) {
    pollStatus();
  }
});

window.addEventListener("online", () => {
  if (state.csrf) pollStatus();
});

// ------------------------------------------------------------------- inicio
async function boot() {
  try {
    const session = await api("/api/auth/session", { csrf: false });
    if (session.authenticated) {
      state.csrf = session.csrf;
      showApp();
      const data = await api("/api/status");
      renderStatus(data);
      els.version.textContent = `CloudDesk ${data.panel?.version ?? ""}`.trim();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

boot();
