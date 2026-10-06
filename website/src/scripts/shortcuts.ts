// The keyboard shortcuts, wired (night phase 15). Imported by src/scripts/site.ts, so it runs on
// every page. It reads the keystrokes, asks src/lib/shortcuts.ts what they mean, carries out the
// global ones (navigation, the search box, the help), and dispatches the context ones as a
// cancelable `oscr:shortcut` event so the page that owns the view can carry them out. It asks the
// Worker for nothing. It never names the platform.
//
// It never fires while the reader is typing in a field, nor while a dialog is open (the dialog owns
// the keyboard, and closes on Escape on its own). The single-key shortcuts are turned off through
// the preferences (pref.shortcuts); the help (?) still opens either way.

import { resolve, tokenOf, helpView, type Shortcut } from "../lib/shortcuts.ts";
import { STRINGS } from "../lib/strings.ts";
import { toDom } from "./dom.ts";

const RESET_MS = 1200;
let buffer: string[] = [];
let timer = 0;

function charKeysOn(): boolean {
  return window.oscr?.getPreference?.("pref.shortcuts") !== "off";
}

function inField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable=true]");
}

/** The shortcuts help, a modal dialog, built fresh on each open (the preference may have changed). */
let dialog: HTMLDialogElement | null = null;
function openHelp(): void {
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.className = "shortcuts-dialog";
    dialog.setAttribute("aria-label", STRINGS.shortcuts.title);
    document.body.appendChild(dialog);
  }
  const header = document.createElement("div");
  header.className = "dialog-head";
  const h2 = document.createElement("h2");
  h2.textContent = STRINGS.shortcuts.title;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = STRINGS.shortcuts.close;
  close.addEventListener("click", () => dialog?.close());
  header.append(h2, close);
  const body = toDom(helpView({ charKeysOn: charKeysOn(), disabledNote: STRINGS.shortcuts.disabledNote }));
  dialog.replaceChildren(header, body);
  if (!dialog.open) dialog.showModal();
}

function runGlobal(s: Shortcut): void {
  if (s.action === "help") {
    openHelp();
  } else if (s.action === "search") {
    const box = document.querySelector<HTMLInputElement>('.masthead input[type="search"]');
    box?.focus();
    box?.select?.();
  } else if (s.action.startsWith("/")) {
    location.assign(s.action);
  }
}

function clearSoon(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    buffer = [];
  }, RESET_MS);
}

document.addEventListener("keydown", (ev) => {
  // A dialog (the help, the palette) owns the keyboard; leave it, Escape closes it natively.
  if (document.querySelector("dialog[open]")) return;
  if (inField(ev.target)) return;
  const token = tokenOf(ev);
  if (token === null) return;

  const { fired, partial, buffer: next } = resolve(buffer, token, charKeysOn());
  buffer = next;

  if (fired.length) {
    const globals = fired.filter((s) => s.global);
    const contexts = fired.filter((s) => !s.global);
    let handled = globals.length > 0;
    for (const s of globals) runGlobal(s);
    for (const s of contexts) {
      const detail = { action: s.action, keys: s.keys };
      const e = new CustomEvent("oscr:shortcut", { detail, cancelable: true, bubbles: true });
      const target = (document.activeElement as HTMLElement) ?? document.body;
      target.dispatchEvent(e);
      if (e.defaultPrevented) handled = true;
    }
    if (handled) ev.preventDefault();
    clearSoon();
  } else if (partial) {
    ev.preventDefault(); // the first key of a sequence (e.g. g) does nothing on its own
    clearSoon();
  }
});
