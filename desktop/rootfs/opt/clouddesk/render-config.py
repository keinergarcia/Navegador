#!/usr/bin/env python3
"""Renderiza la configuración de KasmVNC a partir de la plantilla.

Motivo: KasmVNC permite interpolar variables de entorno en su YAML, pero el
comportamiento depende de la versión. Generar el archivo antes de arrancar es
determinista y permite validar los valores.

Salida: imprime la geometría efectiva ("1366x768") por stdout.
"""
from __future__ import annotations

import json
import os
import re
import sys

TEMPLATE = "/opt/clouddesk/kasmvnc.yaml.tmpl"
STATE_FILE = "/home/desk/.clouddesk/resolution.json"
OUTPUT = "/home/desk/.vnc/kasmvnc.yaml"

MIN_W, MAX_W = 640, 1920
MIN_H, MAX_H = 360, 1200
MAX_PIXELS = 2_304_000  # 1920x1200


def clamp_int(name: str, raw: str, low: int, high: int) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        sys.exit(f"{name} inválido: {raw!r}")
    if not low <= value <= high:
        sys.exit(f"{name} fuera de rango ({low}..{high}): {value}")
    return value


def main() -> None:
    try:
        with open(STATE_FILE, encoding="utf-8") as fh:
            state = json.load(fh)
        width = int(state["width"])
        height = int(state["height"])
    except (OSError, ValueError, KeyError) as exc:
        sys.exit(f"No se pudo leer {STATE_FILE}: {exc}")

    if not (MIN_W <= width <= MAX_W and MIN_H <= height <= MAX_H):
        sys.exit(f"Resolución fuera de rango: {width}x{height}")
    if width * height > MAX_PIXELS:
        sys.exit(f"Resolución demasiado grande: {width}x{height}")
    if width % 2 or height % 2:
        sys.exit("La resolución debe tener dimensiones pares")

    max_fps = clamp_int("KASMVNC_MAX_FPS", os.environ.get("KASMVNC_MAX_FPS", "30"), 5, 60)
    qmin = clamp_int("KASMVNC_QUALITY_MIN", os.environ.get("KASMVNC_QUALITY_MIN", "6"), 0, 9)
    qmax = clamp_int("KASMVNC_QUALITY_MAX", os.environ.get("KASMVNC_QUALITY_MAX", "8"), 0, 9)
    if qmax < qmin:
        qmin, qmax = qmax, qmin

    with open(TEMPLATE, encoding="utf-8") as fh:
        template = fh.read()

    rendered = re.sub(
        r"@([A-Z_]+)@",
        lambda m: str(
            {
                "WIDTH": width,
                "HEIGHT": height,
                "MAX_FPS": max_fps,
                "QMIN": qmin,
                "QMAX": qmax,
                "VNC_USER": os.environ.get("VNC_USER", "desk"),
            }[m.group(1)]
        ),
        template,
    )

    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, "w", encoding="utf-8") as fh:
        fh.write(rendered)

    st = os.stat(OUTPUT)
    os.chown(OUTPUT, st.st_uid, st.st_gid)
    print(f"{width}x{height}")


if __name__ == "__main__":
    main()
