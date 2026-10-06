// The site-wide script (night phase 15), imported once by the main layout (Base.astro), so it runs
// on every page. It applies the reader's preferences to the <html> element, keeps them in step
// across tabs, and offers one function the preferences page and the command palette call to change
// a preference. It never asks the Worker for anything: preferences live in this browser alone
// (localStorage, guarded), zero rows written.
//
// Themes are options, not the default: a reader with no stored theme gets no data-theme attribute,
// so the site stays light (CLAUDE.md). The script sets the attributes as early as it can; the page
// is served light, so at worst a reader who chose dark sees a brief light flash before this runs
// (the Content-Security-Policy forbids an inline script that would set it sooner, D15-n).
//
// Like every browser module, it never names the platform.

import { browserStore, type Store } from "../lib/prefs.ts";
import { appliedAttributes, isPreferenceKey, preferenceOf } from "../lib/preferences.ts";
import "./shortcuts.ts";

const store = (): Store | null => browserStore();

/** Read one stored value, guarded (a private window may throw). */
function readRaw(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Put every preference's current value onto <html>, removing the ones left at their default. */
function applyPreferences(): void {
  const root = document.documentElement;
  const { set, remove } = appliedAttributes(readRaw);
  for (const attr of remove) root.removeAttribute(attr);
  for (const [attr, value] of Object.entries(set)) root.setAttribute(attr, value);
}

/** Change a preference and apply it at once; returns false when the browser would not keep it.
 *  Exposed on window so the preferences page and the palette's theme command can call it. */
function setPreference(key: string, value: string): boolean {
  if (!isPreferenceKey(key)) return false;
  let kept = false;
  try {
    const s = store();
    if (s) {
      s.setItem(key, value);
      kept = true;
    }
  } catch {
    kept = false;
  }
  applyPreferences();
  document.dispatchEvent(new CustomEvent("oscr:prefs-changed", { detail: { key, value } }));
  return kept;
}

/** The current value of a preference (the stored one, or its default). */
function getPreference(key: string): string | undefined {
  const p = preferenceOf(key);
  if (!p) return undefined;
  const raw = readRaw(key);
  return p.options.some((o) => o.value === raw) ? (raw as string) : p.options[0].value;
}

// Apply as soon as the module runs (head, deferred module), then keep every tab in step.
applyPreferences();
window.addEventListener("storage", (e) => {
  if (!e.key || isPreferenceKey(e.key)) applyPreferences();
});

// Focus kept after a reload: a reader who tabbed to a control and reloaded (a theme change reloads
// nothing, but a form submit may) lands back near where they were. The browser restores scroll; we
// move focus to the main landmark so the next Tab continues from the content, not the masthead.
function focusMainOnLoad(): void {
  if (location.hash) return; // an anchor already aims the focus
  const main = document.getElementById("main");
  if (main && !document.activeElement?.closest("input, textarea, select, [contenteditable]")) {
    // Do not steal focus from a field the browser restored; only set the fallback target.
    main.setAttribute("tabindex", "-1");
  }
}
focusMainOnLoad();

interface SiteApi {
  setPreference: (key: string, value: string) => boolean;
  getPreference: (key: string) => string | undefined;
  applyPreferences: () => void;
}
declare global {
  interface Window {
    oscr?: SiteApi & Record<string, unknown>;
  }
}
window.oscr = { ...(window.oscr ?? {}), setPreference, getPreference, applyPreferences };

export { applyPreferences, setPreference, getPreference };
