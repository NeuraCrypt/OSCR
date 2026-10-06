// The preferences page (/settings/preferences/): reads the stored choices on load, writes one when a
// control changes, and resets them (night phase 15). It uses the site-wide script's API (window.oscr,
// from src/scripts/site.ts) so the keys, the storage guard and the applying live in one place. Zero
// Worker requests: this is the browser's own state. It never names the platform.

import { PREFERENCES } from "../lib/preferences.ts";
import { browserStore } from "../lib/prefs.ts";
import { STRINGS } from "../lib/strings.ts";

const api = () => window.oscr;

function selects(): HTMLSelectElement[] {
  return PREFERENCES.map((p) => document.getElementById(p.key)).filter((el): el is HTMLSelectElement => el instanceof HTMLSelectElement);
}

/** Put each control at its current value (the stored one, or the default). */
function fill(): void {
  const get = api()?.getPreference;
  for (const sel of selects()) {
    const v = get?.(sel.id);
    if (v != null) sel.value = v;
  }
}

function saved(): void {
  const el = document.getElementById("prefs-saved");
  if (!el) return;
  el.textContent = STRINGS.preferences.saved;
  window.setTimeout(() => {
    if (el.textContent === STRINGS.preferences.saved) el.textContent = "";
  }, 1500);
}

function init(): void {
  // Say so when the browser will not keep the choices (a private window, blocked site data).
  let keeps = false;
  try {
    const s = browserStore();
    keeps = !!s;
  } catch {
    keeps = false;
  }
  if (!keeps) {
    const note = document.getElementById("prefs-storage");
    if (note) note.hidden = false;
  }

  fill();

  for (const sel of selects()) {
    sel.addEventListener("change", () => {
      api()?.setPreference(sel.id, sel.value);
      saved();
    });
  }

  document.getElementById("prefs-reset")?.addEventListener("click", () => {
    for (const p of PREFERENCES) api()?.setPreference(p.key, p.options[0].value);
    fill();
    saved();
  });

  // Keep the controls in step when another tab or the palette changes a preference.
  document.addEventListener("oscr:prefs-changed", fill);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
