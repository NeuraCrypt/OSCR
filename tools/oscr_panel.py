#!/usr/bin/env python3
"""OSCR control panel: a real window (opened from the Desktop icon) showing the current publication
cycle, whether each step passed, the recent history, and a big on/off switch for the whole engine.

Native Tkinter window, no extra dependency. Reads the cycle history (``oscr.cycles``) and the pause
flag; the switch calls ``tools/oscr_control.sh``. Refreshes itself every few seconds. macOS ignores
the background colour of native buttons, so the buttons here are custom (coloured labels).
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

# A refined dark palette.
BG = "#0e1217"
CARD = "#181f29"
LINE = "#273041"
FG = "#e8eaed"
MUTE = "#8b96a6"
BLUE = "#4a9eff"
GREEN = "#2ecc71"
RED = "#e5484d"
AMBER = "#f5a623"

COLOR = {"ok": GREEN, "failed": RED, "crashed": AMBER, "running": BLUE, "pending": MUTE, "": MUTE}
MARK = {"ok": "✓", "failed": "✗", "crashed": "⚠", "running": "●", "pending": "○"}
# What a cycle of each kind is expected to go through, so the panel always shows the full pipeline.
PIPELINE = {"nightly": ["export", "build", "deploy", "search", "dataset"],
            "refresh": ["export", "dataset"]}
UI = ("Helvetica Neue", 13)
UIB = ("Helvetica Neue", 13, "bold")
BIG = ("Helvetica Neue", 15, "bold")


def control(action: str) -> str:
    try:
        return (subprocess.run(["/bin/zsh", CONTROL, action], capture_output=True,
                               text=True, timeout=40).stdout or "").strip()
    except Exception as e:  # noqa: BLE001
        return f"error:{e}"


def ago(ts) -> str:
    if not ts:
        return "-"
    s = int(time.time() - float(ts))
    for d, u in ((86400, "j"), (3600, "h"), (60, "min")):
        if s >= d:
            return f"il y a {s // d} {u}"
    return f"il y a {s} s"


def dur(a, b) -> str:
    if not a:
        return ""
    s = int((b or time.time()) - a)
    if s >= 3600:
        return f"{s // 3600}h{(s % 3600) // 60:02d}"
    if s >= 60:
        return f"{s // 60}min{s % 60:02d}"
    return f"{s}s"


class Flat(tk.Label):
    """A flat, actually-coloured button (macOS ignores bg on tk.Button)."""

    def __init__(self, master, text, command, bg, fg, font=UIB, padx=16, pady=11):
        super().__init__(master, text=text, bg=bg, fg=fg, font=font, padx=padx, pady=pady,
                         cursor="pointinghand")
        self._bg, self._cmd = bg, command
        self.bind("<Button-1>", lambda _: self._cmd())
        self.bind("<Enter>", lambda _: self.configure(bg=self._shade(self._bg, 0.88)))
        self.bind("<Leave>", lambda _: self.configure(bg=self._bg))

    def recolor(self, text, bg, fg):
        self._bg = bg
        self.configure(text=text, bg=bg, fg=fg)

    @staticmethod
    def _shade(hexc, k):
        r, g, b = (int(hexc[i:i + 2], 16) for i in (1, 3, 5))
        return f"#{int(r*k):02x}{int(g*k):02x}{int(b*k):02x}"


class Panel:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("OSCR")
        root.configure(bg=BG)
        root.geometry("600x680")
        root.minsize(540, 600)

        style = ttk.Style()
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("H.Treeview", background=CARD, fieldbackground=CARD, foreground=FG,
                        rowheight=26, borderwidth=0, font=("Menlo", 11))
        style.configure("H.Treeview.Heading", background=BG, foreground=MUTE,
                        font=("Helvetica Neue", 11, "bold"), borderwidth=0)
        style.map("H.Treeview", background=[("selected", LINE)])

        # Header
        head = tk.Frame(root, bg=BG)
        head.pack(fill="x", padx=22, pady=(20, 10))
        try:
            self.logo = tk.PhotoImage(file=str(LOGO))
            tk.Label(head, image=self.logo, bg=BG).pack(side="left")
        except Exception:  # noqa: BLE001
            pass
        tt = tk.Frame(head, bg=BG)
        tt.pack(side="left", padx=14)
        tk.Label(tt, text="OSCR", bg=BG, fg=FG, font=("Helvetica Neue", 20, "bold")).pack(anchor="w")
        tk.Label(tt, text="Moniteur de publication", bg=BG, fg=MUTE, font=UI).pack(anchor="w")

        # The switch (full width)
        self.switch = Flat(root, "…", self.toggle, GREEN, "#06240c", font=BIG, pady=14)
        self.switch.pack(fill="x", padx=22, pady=(6, 14))

        # Status card
        self.card = tk.Frame(root, bg=CARD)
        self.card.pack(fill="x", padx=22)
        inner = tk.Frame(self.card, bg=CARD)
        inner.pack(fill="x", padx=16, pady=14)
        self.state_dot = tk.Label(inner, text="●", bg=CARD, fg=MUTE, font=("Helvetica Neue", 16))
        self.state_dot.pack(side="left")
        txts = tk.Frame(inner, bg=CARD)
        txts.pack(side="left", padx=10, fill="x", expand=True)
        self.state_lbl = tk.Label(txts, text="", bg=CARD, fg=FG, font=("Helvetica Neue", 15, "bold"), anchor="w")
        self.state_lbl.pack(fill="x")
        self.state_sub = tk.Label(txts, text="", bg=CARD, fg=MUTE, font=UI, anchor="w")
        self.state_sub.pack(fill="x")
        # Steps row
        self.steps = tk.Frame(self.card, bg=CARD)
        self.steps.pack(fill="x", padx=16, pady=(0, 14))

        # History
        hb = tk.Frame(root, bg=BG)
        hb.pack(fill="x", padx=22, pady=(16, 4))
        tk.Label(hb, text="Historique des publications", bg=BG, fg=MUTE, font=UIB).pack(side="left")
        Flat(hb, "Tableau de bord", lambda: subprocess.run(["open", DASH]), LINE, FG,
             font=UI, padx=12, pady=6).pack(side="right")

        wrap = tk.Frame(root, bg=CARD)
        wrap.pack(fill="both", expand=True, padx=22, pady=(4, 20))
        self.tree = ttk.Treeview(wrap, style="H.Treeview", show="headings",
                                 columns=("s", "when", "kind", "dur"), height=10)
        for col, txt, w, anc in (("s", "", 34, "center"), ("when", "Quand", 150, "w"),
                                 ("kind", "Type", 110, "w"), ("dur", "Durée", 90, "w")):
            self.tree.heading(col, text=txt)
            self.tree.column(col, width=w, anchor=anc, stretch=(col == "when"))
        self.tree.pack(fill="both", expand=True, padx=2, pady=2)
        for st, c in COLOR.items():
            self.tree.tag_configure(st or "none", foreground=c)

        self._notified = None
        self.refresh()

    def toggle(self):
        control("resume" if control("status") == "paused" else "pause")
        self.refresh()

    def refresh(self):
        paused = control("status") == "paused"
        if paused:
            self.switch.recolor("▶   Reprendre OSCR", AMBER, "#2a1a00")
        else:
            self.switch.recolor("⏸   Mettre en pause OSCR", GREEN, "#06240c")

        cur = cycles.current()
        for w in self.steps.winfo_children():
            w.destroy()
        if not cur:
            self.state_dot.configure(fg=MUTE)
            self.state_lbl.configure(text="En pause" if paused else "Aucune publication en cours")
            self.state_sub.configure(text="L'historique se remplit a chaque publication.")
        else:
            c, st = cur["cycle"], cur["cycle"]["status"]
            col = COLOR.get(st, FG)
            label = {"running": "Publication en cours", "ok": "Derniere publication reussie",
                     "failed": "Derniere publication en echec", "crashed": "Publication interrompue"}.get(st, st)
            self.state_dot.configure(fg=col)
            self.state_lbl.configure(text=label, fg=col)
            done = {s["name"]: s for s in cur["steps"]}
            total = dur(c["started"], c["finished"])
            self.state_sub.configure(text=f"cycle {c['kind']} · {ago(c['started'])} · duree {total}")
            # chips: the full expected pipeline, each coloured by its real status
            names = PIPELINE.get(c["kind"]) or list(done)
            for n in names:
                s = done.get(n)
                stt = s["status"] if s else "pending"
                d = dur(s["started"], s["finished"]) if s else ""
                chip = tk.Frame(self.steps, bg=BG, highlightthickness=1, highlightbackground=LINE)
                chip.pack(side="left", padx=(0, 8), pady=2)
                tk.Label(chip, text=f"{MARK.get(stt,'?')} {n}" + (f"  {d}" if d else ""),
                         bg=BG, fg=COLOR.get(stt, MUTE), font=("Helvetica Neue", 11), padx=9, pady=5).pack()
            if st in ("failed", "crashed") and self._notified != c["id"]:
                self._notified = c["id"]

        self.tree.delete(*self.tree.get_children())
        for r in cycles.history(40):
            when = time.strftime("%d %b %H:%M", time.localtime(r["started"]))
            self.tree.insert("", "end", tags=(r["status"] or "none",),
                             values=(MARK.get(r["status"], "?"), when, r["kind"],
                                     dur(r["started"], r["finished"]) or "-"))
        self.root.after(3000, self.refresh)


if __name__ == "__main__":
    root = tk.Tk()
    Panel(root)
    root.mainloop()
