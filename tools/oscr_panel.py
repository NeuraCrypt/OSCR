#!/usr/bin/env python3
"""OSCR control panel: a real window (opened from a Desktop icon) showing the current publication
cycle, whether each step passed, the recent history, and a big on/off switch for the whole engine.

Native Tkinter window (no extra dependency). Reads the cycle history (``oscr.cycles``) and the pause
flag; the switch calls ``tools/oscr_control.sh``. Refreshes itself every few seconds.
"""
import subprocess
import sys
import time
import tkinter as tk
from pathlib import Path
from tkinter import ttk

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from oscr import cycles  # noqa: E402

CONTROL = str(ROOT / "tools" / "oscr_control.sh")
LOGO = ROOT / "tools" / "oscr-logo-96.png"
DASH = "http://localhost:8790"

BG = "#0f1419"
FG = "#e6e6e6"
MUTE = "#8a94a6"
COLOR = {"ok": "#39b54a", "failed": "#e5484d", "crashed": "#f0a202", "running": "#4a9eff", "": MUTE}
MARK = {"ok": "✓", "failed": "✗", "crashed": "⚠", "running": "⋯"}


def control(action: str) -> str:
    try:
        return (subprocess.run(["/bin/zsh", CONTROL, action], capture_output=True,
                               text=True, timeout=40).stdout or "").strip()
    except Exception as e:  # noqa: BLE001
        return f"error:{e}"


def ago(ts) -> str:
    if not ts:
        return ""
    s = int(time.time() - float(ts))
    for d, u in ((86400, "j"), (3600, "h"), (60, "min")):
        if s >= d:
            return f"il y a {s // d}{u}"
    return f"il y a {s}s"


class Panel:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("OSCR")
        root.configure(bg=BG)
        root.geometry("560x620")
        root.minsize(480, 520)

        header = tk.Frame(root, bg=BG)
        header.pack(fill="x", padx=20, pady=(18, 8))
        try:
            self.logo = tk.PhotoImage(file=str(LOGO))
            tk.Label(header, image=self.logo, bg=BG).pack(side="left")
        except Exception:  # noqa: BLE001
            pass
        tk.Label(header, text="Open Scientific Code Registry", bg=BG, fg=FG,
                 font=("Helvetica Neue", 16, "bold")).pack(side="left", padx=12)

        # Interrupteur
        sw = tk.Frame(root, bg=BG)
        sw.pack(fill="x", padx=20, pady=6)
        self.switch = tk.Button(sw, text="…", font=("Helvetica Neue", 15, "bold"),
                                relief="flat", command=self.toggle, height=2, width=26)
        self.switch.pack(side="left")
        tk.Button(sw, text="Tableau de bord", relief="flat", bg="#223", fg=FG,
                  command=lambda: subprocess.run(["open", DASH])).pack(side="right")

        # Etat du cycle courant
        self.state_lbl = tk.Label(root, text="", bg=BG, fg=FG, font=("Helvetica Neue", 14), anchor="w")
        self.state_lbl.pack(fill="x", padx=20, pady=(12, 2))
        self.steps_frame = tk.Frame(root, bg=BG)
        self.steps_frame.pack(fill="x", padx=20, pady=4)

        tk.Label(root, text="Historique des publications", bg=BG, fg=MUTE,
                 font=("Helvetica Neue", 11, "bold"), anchor="w").pack(fill="x", padx=20, pady=(14, 2))
        self.hist = tk.Text(root, bg="#0b0f14", fg=FG, height=14, relief="flat",
                            font=("Menlo", 11), padx=10, pady=8, highlightthickness=0)
        self.hist.pack(fill="both", expand=True, padx=20, pady=(0, 16))
        self.hist.configure(state="disabled")
        for name, c in COLOR.items():
            self.hist.tag_configure(name or "none", foreground=c)

        self.refresh()

    def toggle(self):
        control("resume" if control("status") == "paused" else "pause")
        self.refresh()

    def _set_switch(self, paused: bool):
        if paused:
            self.switch.configure(text="▶  Reprendre OSCR", bg="#f0a202", fg="#111",
                                  activebackground="#d89200")
        else:
            self.switch.configure(text="⏸  Mettre en pause OSCR", bg="#39b54a", fg="#06240c",
                                  activebackground="#2e9a3e")

    def refresh(self):
        paused = control("status") == "paused"
        self._set_switch(paused)

        cur = cycles.current()
        for w in self.steps_frame.winfo_children():
            w.destroy()
        if not cur:
            self.state_lbl.configure(text="En pause." if paused else "Aucun cycle de publication encore.")
        else:
            c = cur["cycle"]
            st = c["status"]
            self.state_lbl.configure(
                text=f"Cycle {c['kind']} : {MARK.get(st, '?')} {st}   ({ago(c['started'])})",
                fg=COLOR.get(st, FG))
            for s in cur["steps"]:
                tk.Label(self.steps_frame, text=f"{MARK.get(s['status'], '?')}  {s['name']}",
                         bg=BG, fg=COLOR.get(s["status"], MUTE), font=("Helvetica Neue", 12),
                         anchor="w").pack(fill="x")

        self.hist.configure(state="normal")
        self.hist.delete("1.0", "end")
        rows = cycles.history(25)
        if not rows:
            self.hist.insert("end", "aucune publication enregistree pour l'instant\n", "none")
        for r in rows:
            when = time.strftime("%m-%d %H:%M", time.localtime(r["started"]))
            line = f"{MARK.get(r['status'], '?')}  {when}  {r['kind']:<8} {r['status']}\n"
            self.hist.insert("end", line, r["status"] or "none")
        self.hist.configure(state="disabled")

        self.root.after(3000, self.refresh)


if __name__ == "__main__":
    root = tk.Tk()
    Panel(root)
    root.mainloop()
