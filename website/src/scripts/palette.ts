// The command palette, wired (night phase 15). Imported by src/scripts/site.ts, so Ctrl/Cmd+K opens
// it on every page. It jumps to a page or runs a command from a STATIC index (src/lib/palette.ts):
// it asks the Worker for nothing. Keyboard-navigable and screen-reader friendly (a combobox over a
// listbox, aria-activedescendant). It never names the platform.

import { flatten, search, type PaletteEntry, type ResultGroup } from "../lib/palette.ts";
import { STRINGS } from "../lib/strings.ts";

const S = STRINGS.palette;
let dialog: HTMLDialogElement | null = null;
let input: HTMLInputElement | null = null;
let list: HTMLUListElement | null = null;
let order: PaletteEntry[] = [];
let active = -1;

function build(): void {
  dialog = document.createElement("dialog");
  dialog.className = "command-palette";
  dialog.setAttribute("aria-label", S.label);

  input = document.createElement("input");
  input.className = "palette-input";
  input.type = "text";
  input.placeholder = S.placeholder;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", "palette-list");
  input.setAttribute("aria-autocomplete", "list");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", S.placeholder);

  const hint = document.createElement("p");
  hint.className = "palette-hint";
  hint.textContent = S.hint;

  list = document.createElement("ul");
  list.id = "palette-list";
  list.className = "palette-results";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", S.label);

  dialog.append(input, hint, list);
  document.body.appendChild(dialog);

  input.addEventListener("input", render);
  input.addEventListener("keydown", onKey);
  dialog.addEventListener("close", () => {
    if (input) input.value = "";
  });
  // A click on the backdrop (outside the content) closes it.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}

function highlight(title: string, ranges: [number, number][]): DocumentFragment {
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const [s, e] of ranges) {
    if (s > at) frag.appendChild(document.createTextNode(title.slice(at, s)));
    const m = document.createElement("mark");
    m.textContent = title.slice(s, e);
    frag.appendChild(m);
    at = e;
  }
  if (at < title.length) frag.appendChild(document.createTextNode(title.slice(at)));
  return frag;
}

function render(): void {
  if (!input || !list) return;
  const groups: ResultGroup[] = search(input.value);
  order = flatten(groups);
  active = order.length ? 0 : -1;
  list.replaceChildren();
  if (!order.length) {
    const empty = document.createElement("li");
    empty.className = "palette-empty";
    empty.setAttribute("role", "presentation");
    empty.textContent = S.empty;
    list.appendChild(empty);
    input.removeAttribute("aria-activedescendant");
    return;
  }
  let i = 0;
  for (const g of groups) {
    const head = document.createElement("li");
    head.className = "palette-group";
    head.setAttribute("role", "presentation");
    head.textContent = g.title;
    list.appendChild(head);
    for (const m of g.matches) {
      const li = document.createElement("li");
      li.className = "palette-option";
      li.id = `palette-opt-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", i === active ? "true" : "false");
      li.dataset.index = String(i);
      const label = document.createElement("span");
      label.className = "palette-label";
      label.appendChild(highlight(m.entry.title, m.ranges));
      li.appendChild(label);
      if (m.entry.hint) {
        const hint = document.createElement("span");
        hint.className = "palette-kind";
        hint.textContent = m.entry.hint;
        li.appendChild(hint);
      }
      const index = i;
      li.addEventListener("click", () => activate(index));
      li.addEventListener("mousemove", () => select(index));
      list.appendChild(li);
      i++;
    }
  }
  select(active);
}

function options(): HTMLElement[] {
  return list ? Array.from(list.querySelectorAll<HTMLElement>("li.palette-option")) : [];
}

function select(index: number): void {
  const opts = options();
  if (!opts.length) return;
  active = Math.max(0, Math.min(index, opts.length - 1));
  opts.forEach((o, k) => o.setAttribute("aria-selected", k === active ? "true" : "false"));
  const chosen = opts[active];
  if (chosen && input) input.setAttribute("aria-activedescendant", chosen.id);
  chosen?.scrollIntoView({ block: "nearest" });
}

function activate(index: number): void {
  const entry = order[index];
  if (!entry) return;
  dialog?.close();
  if (entry.href) {
    location.assign(entry.href);
  } else if (entry.command) {
    runCommand(entry.command);
  }
}

function runCommand(command: string): void {
  const [name, value] = command.split(":");
  if (name === "theme") window.oscr?.setPreference?.("pref.theme", value);
  else if (name === "contrast") window.oscr?.setPreference?.("pref.contrast", value);
  else if (name === "help") document.dispatchEvent(new CustomEvent("oscr:open-shortcuts"));
}

function onKey(ev: KeyboardEvent): void {
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    select(active + 1);
  } else if (ev.key === "ArrowUp") {
    ev.preventDefault();
    select(active - 1);
  } else if (ev.key === "Enter") {
    ev.preventDefault();
    if (active >= 0) activate(active);
  }
  // Escape is handled natively by the dialog.
}

function open(): void {
  if (!dialog) build();
  if (!dialog || !input) return;
  input.value = "";
  render();
  if (!dialog.open) dialog.showModal();
  input.focus();
}

document.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "k") {
    ev.preventDefault();
    if (dialog?.open) dialog.close();
    else open();
  }
});
