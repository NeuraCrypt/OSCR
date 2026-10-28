#!/usr/bin/env python3
"""OSCR menu-bar monitor (top-right of the Mac): the current publication cycle, whether each step
passed, a history window, and an on/off switch for the whole engine.

Runs as a LaunchAgent (org.oscr.menubar), independent of Claude. Reads the cycle history
(``oscr.cycles``) and the pause flag; the switch calls ``tools/oscr_control.sh``. Lightweight:
one small status item refreshed every few seconds, built with rumps.
"""
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]          # ~/OSCR
sys.path.insert(0, str(ROOT))

import rumps  # noqa: E402
from oscr import cycles  # noqa: E402

CONTROL = str(ROOT / "tools" / "oscr_control.sh")
ICON = str(ROOT / "tools" / "oscr-icon.png")         # on the SSD, never the HDD
DASH = "http://localhost:8790"
MARK = {"ok": "✓", "failed": "✗", "crashed": "⚠", "running": "⋯"}  # ✓ ✗ ⚠ ⋯


def control(action: str) -> str:
    try:
        r = subprocess.run(["/bin/zsh", CONTROL, action], capture_output=True, text=True, timeout=40)
        return (r.stdout or "").strip()
    except Exception as e:  # noqa: BLE001
        return f"error:{e}"


def ago(ts) -> str:
    if not ts:
        return ""
    s = int(time.time() - float(ts))
    if s < 60:
        return f"il y a {s}s"
    if s < 3600:
        return f"il y a {s // 60}min"
    if s < 86400:
        return f"il y a {s // 3600}h"
    return f"il y a {s // 86400}j"


class Oscr(rumps.App):
    def __init__(self):
        icon = ICON if os.path.exists(ICON) else None
        super().__init__("OSCR", icon=icon, template=False, quit_button="Quitter le moniteur")
        self.status_item = rumps.MenuItem("…")
        self.steps_item = rumps.MenuItem("étapes: …")
        self.switch = rumps.MenuItem("Mettre en pause", callback=self.toggle)
        self.menu = [
            self.status_item,
            self.steps_item,
            None,
            self.switch,
            rumps.MenuItem("Ouvrir le tableau de bord", callback=lambda _: subprocess.run(["open", DASH])),
            rumps.MenuItem("Historique…", callback=self.show_history),
            None,
        ]
        self._last_bad = None
        self.refresh(None)

    @rumps.timer(5)
    def refresh(self, _):
        paused = control("status") == "paused"
        self.switch.title = "Reprendre OSCR" if paused else "Mettre en pause OSCR"
        cur = cycles.current()
        if not cur:
            self.title = " ⏸" if paused else ""
            self.status_item.title = "En pause" if paused else "Aucun cycle encore"
            self.steps_item.title = "étapes: -"
            return
        c = cur["cycle"]
        st = c["status"]
        self.status_item.title = f"Publication {MARK.get(st, '?')} {st}  ({ago(c['started'])})"
        parts = [f"{s['name']}{MARK.get(s['status'], '?')}" for s in cur["steps"]]
        self.steps_item.title = "étapes: " + ("  ".join(parts) if parts else "-")
        # Icone/titre: pause > alerte (echec/crash) > normal
        if paused:
            self.title = " ⏸"
        elif st in ("crashed", "failed"):
            self.title = " ⚠"
            if self._last_bad != c["id"]:
                self._last_bad = c["id"]
                rumps.notification("OSCR", f"Publication {st}", c.get("detail") or "voir l'historique")
        else:
            self.title = ""

    def toggle(self, _):
        if control("status") == "paused":
            control("resume")
            rumps.notification("OSCR", "", "Moteur relancé")
        else:
            control("pause")
            rumps.notification("OSCR", "", "Moteur mis en pause")
        self.refresh(None)

    def show_history(self, _):
        rows = cycles.history(15)
        lines = [f"{MARK.get(r['status'], '?')} {time.strftime('%m-%d %H:%M', time.localtime(r['started']))}"
                 f"  {r['kind']}  {r['status']}" for r in rows]
        body = "Derniers cycles de publication :\n\n" + ("\n".join(lines) if lines else "aucun pour l'instant")
        rumps.Window(body, "Historique OSCR", ok="Fermer", dimensions=(380, 260)).run()


if __name__ == "__main__":
    Oscr().run()
