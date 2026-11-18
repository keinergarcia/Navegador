#!/usr/bin/env python3
"""Agente interno del escritorio CloudDesk.

Se ejecuta dentro del contenedor del escritorio (red interna, nunca publicado)
y expone operaciones de sesión y métricas al API. Todas las peticiones exigen
el token compartido AGENT_TOKEN.

Endpoints:
  GET  /health                -> estado básico (sin token: solo liveness)
  GET  /status                -> métricas y estado de la sesión
  POST /session/start         -> arranca la sesión si está detenida
  POST /session/stop          -> detiene la sesión (libera CPU/RAM)
  POST /session/restart       -> reinicia la sesión completa
  POST /session/resolution    -> {"width":W,"height":H} + reinicio
  POST /heartbeat             -> actividad del panel (para el idle stop)
"""
from __future__ import annotations

import hmac
import json
import os
import pwd
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

TOKEN = os.environ["AGENT_TOKEN"].encode()
PORT = int(os.environ.get("AGENT_PORT", "8099"))
IDLE_MINUTES = float(os.environ.get("IDLE_STOP_MINUTES", "0") or 0)
SUPERVISORCTL = "/usr/bin/supervisorctl"
STATE_DIR = "/home/desk/.clouddesk"
RES_FILE = os.path.join(STATE_DIR, "resolution.json")
VNC_PORT = 8444

MAX_W, MAX_H = 1920, 1200
MIN_W, MIN_H = 640, 360
MAX_PIXELS = 2_304_000

_lock = threading.Lock()
_last_activity = time.time()
_idle_stopped = False
_started_at = time.time()


# --------------------------------------------------------------------------- #
# Utilidades
# --------------------------------------------------------------------------- #
def run(cmd: list[str], timeout: float = 40.0) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            text=True,
            env={**os.environ, "LC_ALL": "C"},
        )
        return proc.returncode, (proc.stdout or "").strip()
    except subprocess.TimeoutExpired:
        return 124, f"timeout ejecutando {' '.join(cmd)}"
    except OSError as exc:
        return 127, f"no se pudo ejecutar {cmd[0]}: {exc}"


def supervisor_status() -> dict[str, dict[str, Any]]:
    """Devuelve {programa: {state, pid, raw}}."""
    rc, out = run([SUPERVISORCTL, "status"], timeout=8)
    result: dict[str, dict[str, Any]] = {}
    if rc not in (0, 3):  # supervisorctl status: 3 = algún programa no RUNNING
        return result
    for line in out.splitlines():
        m = re.match(r"^(\S+)\s+(\w+)\s*(?:pid (\d+), uptime (.*))?$", line.strip())
        if not m:
            continue
        result[m.group(1)] = {
            "state": m.group(2),
            "pid": int(m.group(3)) if m.group(3) else None,
            "uptime": m.group(4) or None,
        }
    return result


def parse_uptime(text: str | None) -> int | None:
    if not text:
        return None
    days = 0
    rest = text.strip()
    m = re.match(r"^(\d+) day[s]?,?\s*(.*)$", rest)
    if m:
        days = int(m.group(1))
        rest = m.group(2)
    parts = rest.split(":")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    if len(nums) == 3:
        h, mi, s = nums
    elif len(nums) == 2:
        h, mi, s = 0, nums[0], nums[1]
    elif len(nums) == 1:
        h, mi, s = 0, 0, nums[0]
    else:
        return None
    return days * 86400 + h * 3600 + mi * 60 + s


def read_first(path: str) -> str | None:
    try:
        with open(path, encoding="ascii", errors="replace") as fh:
            return fh.read().strip()
    except OSError:
        return None


def read_cgroup_int(*paths: str) -> int | None:
    for path in paths:
        raw = read_first(path)
        if raw is None or raw == "max":
            continue
        try:
            return int(raw)
        except ValueError:
            continue
    return None


def meminfo() -> dict[str, int]:
    data: dict[str, int] = {}
    try:
        with open("/proc/meminfo", encoding="ascii") as fh:
            for line in fh:
                key, _, rest = line.partition(":")
                value = rest.strip().split()
                if value and value[0].isdigit():
                    data[key] = int(value[0]) * 1024
    except OSError:
        pass
    return data


def cpu_usage_usec() -> int | None:
    raw = read_first("/sys/fs/cgroup/cpu.stat")
    if raw:
        for line in raw.splitlines():
            if line.startswith("usage_usec"):
                try:
                    return int(line.split()[1])
                except (IndexError, ValueError):
                    return None
    return None


def established_connections(port: int = VNC_PORT) -> int:
    """Cuenta sockets TCP establecidos hacia el puerto del servidor VNC."""
    count = 0
    needle = f":{port:04X}"
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(path, encoding="ascii") as fh:
                next(fh, None)
                for line in fh:
                    fields = line.split()
                    if len(fields) < 4:
                        continue
                    if not fields[1].endswith(needle):
                        continue
                    if fields[3] == "01":  # ESTABLISHED
                        count += 1
        except OSError:
            continue
    return count


def chromium_stats() -> dict[str, Any]:
    procs = 0
    rss_bytes = 0
    page = os.sysconf("SC_PAGE_SIZE")
    try:
        entries = os.listdir("/proc")
    except OSError:
        return {"processes": 0, "rssMb": 0}
    for entry in entries:
        if not entry.isdigit():
            continue
        comm = read_first(f"/proc/{entry}/comm")
        if not comm or "chrom" not in comm.lower():
            continue
        procs += 1
        statm = read_first(f"/proc/{entry}/statm")
        if statm:
            parts = statm.split()
            if len(parts) > 1 and parts[1].isdigit():
                rss_bytes += int(parts[1]) * page
    return {"processes": procs, "rssMb": round(rss_bytes / 1048576, 1)}


def disk_stats() -> dict[str, Any]:
    try:
        usage = shutil.disk_usage("/home/desk")
    except OSError:
        return {"usedMb": None, "totalMb": None, "percent": None}
    percent = round(usage.used / usage.total * 100, 1) if usage.total else None
    return {
        "usedMb": round(usage.used / 1048576),
        "totalMb": round(usage.total / 1048576),
        "percent": percent,
    }


def read_resolution() -> dict[str, int]:
    try:
        with open(RES_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
        return {"width": int(data["width"]), "height": int(data["height"])}
    except (OSError, ValueError, KeyError, TypeError):
        return {"width": 1366, "height": 768}


def write_resolution(width: int, height: int) -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = RES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"width": width, "height": height}, fh)
    try:
        info = pwd.getpwnam("desk")
        os.chown(tmp, info.pw_uid, info.pw_gid)
    except KeyError:
        pass
    os.replace(tmp, RES_FILE)


def touch_activity() -> None:
    global _last_activity, _idle_stopped
    with _lock:
        _last_activity = time.time()
        _idle_stopped = False


def system_uptime() -> int | None:
    text = read_first("/proc/uptime")
    if not text:
        return None
    try:
        return int(float(text.split()[0]))
    except (ValueError, IndexError):
        return None


# --------------------------------------------------------------------------- #
# Acciones
# --------------------------------------------------------------------------- #
def session_action(action: str) -> tuple[int, str]:
    if action == "restart":
        touch_activity()
        return run([SUPERVISORCTL, "restart", "session"], timeout=45)
    if action == "stop":
        # Detener la sesión también detiene Chromium: pedimos cierre ordenado.
        run(["pkill", "-TERM", "-u", "desk", "-f", "chromium"], timeout=5)
        time.sleep(2)
        return run([SUPERVISORCTL, "stop", "session"], timeout=40)
    if action == "start":
        touch_activity()
        return run([SUPERVISORCTL, "start", "session"], timeout=45)
    return 2, f"acción desconocida: {action}"


def status_payload() -> dict[str, Any]:
    sup = supervisor_status()
    session = sup.get("session", {"state": "UNKNOWN", "pid": None, "uptime": None})
    state_map = {
        "RUNNING": "running",
        "STARTING": "starting",
        "STOPPED": "stopped",
        "STOPPING": "stopping",
        "BACKOFF": "error",
        "FATAL": "error",
        "EXITED": "error",
        "UNKNOWN": "unknown",
    }
    mem = meminfo()
    mem_used = read_cgroup_int("/sys/fs/cgroup/memory.current")
    mem_limit = read_cgroup_int("/sys/fs/cgroup/memory.max")
    with _lock:
        idle_for = int(time.time() - _last_activity)
    return {
        "session": {
            "state": state_map.get(session["state"], "unknown"),
            "supervisorState": session["state"],
            "pid": session["pid"],
            "uptimeSeconds": parse_uptime(session["uptime"]),
            "resolution": read_resolution(),
            "connections": established_connections(),
        },
        "chromium": chromium_stats(),
        "cpu": {
            "cores": os.cpu_count() or 1,
            "load1": round(os.getloadavg()[0], 2),
            "usageUsec": cpu_usage_usec(),
        },
        "memory": {
            "usedMb": round(mem_used / 1048576) if mem_used is not None else None,
            "limitMb": round(mem_limit / 1048576) if mem_limit else None,
            "hostTotalMb": round(mem.get("MemTotal", 0) / 1048576) or None,
            "hostAvailableMb": round(mem.get("MemAvailable", 0) / 1048576) or None,
        },
        "disk": disk_stats(),
        "idle": {
            "stopAfterMinutes": IDLE_MINUTES,
            "idleForSeconds": idle_for,
        },
        "systemUptimeSeconds": system_uptime(),
        "now": int(time.time()),
    }


# --------------------------------------------------------------------------- #
# Suspensión por inactividad
# --------------------------------------------------------------------------- #
def idle_loop() -> None:
    if IDLE_MINUTES <= 0:
        print("[agent] suspensión por inactividad desactivada", flush=True)
        return
    limit = IDLE_MINUTES * 60
    print(f"[agent] suspensión por inactividad: {IDLE_MINUTES:g} min", flush=True)
    while True:
        time.sleep(30)
        try:
            if established_connections() > 0:
                touch_activity()
                continue
            with _lock:
                idle_for = time.time() - _last_activity
                already = _idle_stopped
            if already or idle_for < limit:
                continue
            sup = supervisor_status().get("session", {})
            if sup.get("state") != "RUNNING":
                continue
            print(f"[agent] sesión inactiva {int(idle_for)}s: deteniendo", flush=True)
            rc, out = session_action("stop")
            with _lock:
                _idle_stopped = True
            print(f"[agent] stop rc={rc} {out[:200]}", flush=True)
        except Exception as exc:  # noqa: BLE001 - el hilo no debe morir
            print(f"[agent] error en idle_loop: {exc}", flush=True)


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "CloudDeskAgent/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        sys.stdout.write(
            f"[agent] {self.address_string()} {fmt % args}\n"
        )
        sys.stdout.flush()

    # -- helpers ------------------------------------------------------------
    def _json(self, code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _authorized(self) -> bool:
        header = self.headers.get("X-CloudDesk-Token", "")
        return bool(header) and hmac.compare_digest(header.encode(), TOKEN)

    def _read_json(self, limit: int = 4096) -> dict[str, Any] | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length <= 0 or length > limit:
            return None
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError):
            return None
        return data if isinstance(data, dict) else None

    # -- rutas --------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._json(200, {"ok": True, "agentUptime": int(time.time() - _started_at)})
            return
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        if path == "/status":
            try:
                self._json(200, {"ok": True, **status_payload()})
            except Exception as exc:  # noqa: BLE001
                self._json(500, {"ok": False, "error": str(exc)})
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return

        if path == "/heartbeat":
            touch_activity()
            self._json(200, {"ok": True})
            return

        if path in ("/session/start", "/session/stop", "/session/restart"):
            action = path.rsplit("/", 1)[1]
            rc, out = session_action(action)
            payload: dict[str, Any] = {"ok": rc == 0, "action": action}
            if rc != 0:
                payload["error"] = out[:500]
            self._json(200 if rc == 0 else 502, payload)
            return

        if path == "/session/resolution":
            data = self._read_json()
            if not data:
                self._json(400, {"error": "invalid_body"})
                return
            try:
                width = int(data.get("width"))
                height = int(data.get("height"))
            except (TypeError, ValueError):
                self._json(400, {"error": "invalid_dimensions"})
                return
            if (
                not (MIN_W <= width <= MAX_W and MIN_H <= height <= MAX_H)
                or width * height > MAX_PIXELS
                or width % 2
                or height % 2
            ):
                self._json(400, {"error": "dimensions_out_of_range"})
                return
            write_resolution(width, height)
            rc, out = session_action("restart")
            if rc != 0:
                self._json(502, {"ok": False, "error": out[:500]})
                return
            self._json(200, {"ok": True, "resolution": {"width": width, "height": height}})
            return

        self._json(404, {"error": "not_found"})

    def do_HEAD(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] == "/health":
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()


def main() -> None:
    if len(TOKEN) < 32:
        sys.exit("AGENT_TOKEN demasiado corto")

    def _shutdown(_signum: int, _frame: Any) -> None:
        print("[agent] cerrando", flush=True)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    threading.Thread(target=idle_loop, name="idle", daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print(f"[agent] escuchando en 0.0.0.0:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
