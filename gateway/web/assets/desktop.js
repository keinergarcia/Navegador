// CloudDesk - visor inmersivo (iframe de KasmVNC + barra de control propia).

const $ = (selector) => document.querySelector(selector);
const iframe = $("#vnc");
const status = $("#dstatus");
const statusText = $("#dstatus-text");
const title = $("#dtitle");
const note = $("#note");
const noteText = $("#note-text");
const noteLink = $("#note-link");
const direct = $("#direct");
const fullscreenBtn = $("#fullscreen");

let csrf = null;
let loaded = false;
let alive = false;

function setStatus(kind, text) {
  status.dataset.state = kind;
  statusText.textContent = text;
}

async function getSession() {
  const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) return null;
  return response.json();
}

async function load() {
  const session = await getSession();
  if (!session?.authenticated) {
    window.location.replace("/");
    return;
  }
  csrf = session.csrf;

  const response = await fetch("/api/config", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    window.location.replace("/");
    return;
  }
  const config = await response.json();
  if (!config.vncUrl) {
    note.hidden = false;
    noteText.textContent = "El host del escritorio no está configurado.";
    return;
  }

  direct.href = config.vncUrl;
  iframe.src = config.vncUrl;

  if (!document.documentElement.requestFullscreen) {
    fullscreenBtn.hidden = true;
  }

  iframe.addEventListener("load", () => {
    loaded = true;
    note.hidden = true;
    setStatus("online", "Conectado");
  });

  // Si el iframe no carga (bloqueo de cookies, red, sesión), avisamos.
  setTimeout(() => {
    if (!loaded) {
      note.hidden = false;
      noteText.textContent =
        "El escritorio tarda en responder. Si ves una pantalla en blanco, ábrelo en una pestaña nueva.";
    }
  }, 15000);
}

async function poll() {
  try {
    const response = await fetch("/api/status", { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) {
      window.location.replace("/");
      return;
    }
    if (!response.ok) throw new Error("status");
    const data = await response.json();
    alive = data.agentOnline !== false;
    const session = data.session || {};
    if (session.state === "running") {
      setStatus(alive ? "online" : "waiting", alive ? "Conectado" : "Sincronizando");
      if (session.resolution) {
        title.textContent = `${session.resolution.width} × ${session.resolution.height}`;
      }
    } else if (session.state === "stopped") {
      setStatus("offline", "Detenido");
      note.hidden = false;
      noteText.textContent = "La sesión está detenida.";
    } else {
      setStatus("waiting", "Iniciando");
    }

    if (csrf) {
      fetch("/api/heartbeat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-CloudDesk-CSRF": csrf },
      }).catch(() => {});
    }
  } catch {
    setStatus("offline", "Sin red");
  }
}

fullscreenBtn?.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    // iOS Safari no permite fullscreen de elementos: se ignora.
  }
});

$("#restart").addEventListener("click", async () => {
  if (!window.confirm("Se reiniciará el escritorio y se cerrarán las aplicaciones abiertas. ¿Continuar?")) return;
  if (!csrf) return;
  setStatus("waiting", "Reiniciando");
  try {
    const response = await fetch("/api/session/restart", {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-CloudDesk-CSRF": csrf },
    });
    if (!response.ok) throw new Error("restart");
    setTimeout(() => {
      iframe.src = iframe.src;
    }, 2500);
  } catch {
    note.hidden = false;
    noteText.textContent = "No se pudo reiniciar la sesión. Vuelve al panel.";
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") poll();
});

load().then(poll).catch(() => {
  setStatus("offline", "Error");
  note.hidden = false;
  noteText.textContent = "No se pudo cargar la configuración del escritorio.";
});

setInterval(poll, 20000);
