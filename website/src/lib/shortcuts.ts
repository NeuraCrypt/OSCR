// The keyboard shortcuts of the whole site (night phase 15): which keys do what, the matcher that
// turns a keystroke into a shortcut (ignoring keystrokes while typing, and the single-key shortcuts
// when the reader turned them off), and the help dialog's content. Pure, no DOM, tested in Node
// (tests/forge-pages/shortcuts.test.ts). The script (src/scripts/shortcuts.ts) wires it.
//
// Two kinds. The global shortcuts (navigation, the search box, the help itself) act on every page:
// the script carries them out. The context shortcuts (the code views, the lists, the issues and
// pull requests, the notifications) are dispatched as a `oscr:shortcut` event for the page that owns
// that view to carry out; a page that does not yet listen simply ignores them (each page's own phase
// wires what it needs, NIGHT_RUN §4). They are shown in the help so a reader learns them.
//
// Shortcuts match GitHub's where they exist, so a researcher keeps their habits. Like every browser
// module, it never names the platform: the sentences say "the registry" or nothing.

import { type El, h } from "./repo-view.ts";

export interface Shortcut {
  /** The key sequence to match, as tokens (see tokenOf): e.g. ["g", "s"], ["?"], ["shift+u"]. */
  seq: string[];
  /** How the keys read in the help: e.g. "g s", "?", "Shift U". */
  keys: string;
  /** What it does, in plain words. */
  describe: string;
  /** A global shortcut the site-wide script carries out itself: a path to go to, or one of the
   *  built-in actions "help" and "search". A context shortcut has an id dispatched as an event. */
  action: string;
  /** Carried out on every page by the script (navigation, the search box, the help). */
  global?: boolean;
  /** Works even when single-key shortcuts are turned off (only the help). */
  alwaysOn?: boolean;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: "Anywhere",
    shortcuts: [
      { seq: ["?"], keys: "?", describe: "Open this list of keyboard shortcuts", action: "help", global: true, alwaysOn: true },
      { seq: ["/"], keys: "/", describe: "Jump to the search box", action: "search", global: true },
      { seq: ["g", "h"], keys: "g h", describe: "Go to the home page", action: "/", global: true },
      { seq: ["g", "s"], keys: "g s", describe: "Go to search", action: "/search/", global: true },
      { seq: ["g", "b"], keys: "g b", describe: "Go to browse", action: "/browse/", global: true },
      { seq: ["g", "r"], keys: "g r", describe: "Go to your repositories", action: "/repositories/", global: true },
      { seq: ["g", "e"], keys: "g e", describe: "Go to explore", action: "/explore/", global: true },
      { seq: ["g", "n"], keys: "g n", describe: "Go to notifications", action: "/notifications/", global: true },
      { seq: ["g", "a"], keys: "g a", describe: "Go to your account", action: "/account/", global: true },
    ],
  },
  {
    title: "Reading code",
    shortcuts: [
      { seq: ["t"], keys: "t", describe: "Find a file by name", action: "code.find" },
      { seq: ["l"], keys: "l", describe: "Go to a line", action: "code.line" },
      { seq: ["w"], keys: "w", describe: "Switch branch or tag", action: "code.ref" },
      { seq: ["y"], keys: "y", describe: "Copy a permanent link (the exact commit)", action: "code.permalink" },
      { seq: ["b"], keys: "b", describe: "Show who last changed each line (blame)", action: "code.blame" },
      { seq: ["e"], keys: "e", describe: "Edit this file", action: "code.edit" },
    ],
  },
  {
    title: "Lists, issues and pull requests",
    shortcuts: [
      { seq: ["j"], keys: "j", describe: "Move down the list", action: "list.next" },
      { seq: ["k"], keys: "k", describe: "Move up the list", action: "list.previous" },
      { seq: ["o"], keys: "o", describe: "Open the selected item", action: "list.open" },
      { seq: ["e"], keys: "e", describe: "Mark the notification done", action: "notifications.done" },
      { seq: ["shift+u"], keys: "Shift U", describe: "Mark the notification unread", action: "notifications.unread" },
      { seq: ["i"], keys: "I", describe: "Mark the notification read", action: "notifications.read" },
      { seq: ["m"], keys: "M", describe: "Mute the thread", action: "notifications.mute" },
    ],
  },
];

/** Every shortcut, flat. */
export const ALL_SHORTCUTS: readonly Shortcut[] = SHORTCUT_GROUPS.flatMap((g) => g.shortcuts);

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** A keystroke as a token, or null when it is not one a shortcut uses. A key held with Ctrl, Cmd or
 *  Alt is never a shortcut here (the command palette owns Ctrl/Cmd+K). A letter with Shift becomes
 *  "shift+<letter>"; "?" and "/" stay themselves. */
export function tokenOf(ev: KeyLike): string | null {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  const k = ev.key;
  if (!k || k.length !== 1) return null;
  const lower = k.toLowerCase();
  if (ev.shiftKey && /[a-z]/.test(lower)) return `shift+${lower}`;
  return lower;
}

const eq = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const startsWith = (seq: readonly string[], buf: readonly string[]): boolean => buf.length < seq.length && buf.every((x, i) => x === seq[i]);

export interface Resolution {
  /** The shortcuts that fired. Several can share a sequence (the same key means one thing reading
   *  code, another in a list): the script runs the global one and dispatches the context ones, and
   *  the page that owns the active view carries out the one meant for it. */
  fired: Shortcut[];
  /** The buffer is a prefix of a longer sequence: keep it and wait for the next key. */
  partial: boolean;
  /** The buffer to carry forward (empty once something fired or nothing can match). */
  buffer: string[];
}

/** Advance the key buffer with one token. `charKeysOn` false allows only the always-on shortcuts
 *  (the help). A keystroke while typing in a field is never a shortcut: the caller passes nothing. */
export function resolve(buffer: readonly string[], token: string, charKeysOn = true): Resolution {
  const usable = ALL_SHORTCUTS.filter((s) => charKeysOn || s.alwaysOn);
  const tryBuf = (buf: string[]): Resolution | null => {
    const exact = usable.filter((s) => eq(s.seq, buf));
    if (exact.length) return { fired: exact, partial: false, buffer: [] };
    if (usable.some((s) => startsWith(s.seq, buf))) return { fired: [], partial: true, buffer: buf };
    return null;
  };
  // The token continues the current buffer, or starts a fresh one.
  return tryBuf([...buffer, token]) ?? tryBuf([token]) ?? { fired: [], partial: false, buffer: [] };
}

/** The help dialog's content, as a view tree: the groups, each a table of keys and what they do.
 *  `charKeysOn` false adds the note that the single-key shortcuts are off. */
export function helpView(opts: { charKeysOn?: boolean; disabledNote?: string } = {}): El {
  const groups = SHORTCUT_GROUPS.map((g) =>
    h(
      "section",
      { class: "shortcut-group" },
      h("h3", null, g.title),
      h(
        "table",
        { class: "shortcut-table" },
        h(
          "tbody",
          null,
          ...g.shortcuts.map((s) =>
            h(
              "tr",
              null,
              h("td", { class: "shortcut-keys" }, ...s.keys.split(" ").map((part) => h("kbd", null, part))),
              h("td", null, s.describe),
            ),
          ),
        ),
      ),
    ),
  );
  const note = opts.charKeysOn === false && opts.disabledNote ? h("p", { class: "warning" }, opts.disabledNote) : null;
  return h("div", { class: "shortcut-help" }, note, ...groups);
}
