// What a reader chooses for the whole site, kept in their browser (night phase 15). Pure, no DOM:
// the schema, the defaults and how a choice becomes an attribute on the <html> element. The
// site-wide script (src/scripts/site.ts) applies it on every page; the preferences page
// (src/scripts/preferences.ts) reads and writes it. Tested in tests/forge-pages/preferences.test.ts.
//
// Every value lives in localStorage under its key. Storage may be missing or refuse (a private
// window, blocked site data): the readers here are pure and take the stored value as an argument,
// so the browser's guards (src/lib/prefs.ts) stay in one place. The page works the same with the
// defaults when nothing is stored. Zero rows are written: this is the browser's own state, synced
// to the account only when the reader asks (deferred, D15-n).
//
// Themes are options, not the default: light has no attribute at all; a dark theme and the
// colour-vision palettes are chosen (html[data-theme], html[data-vision]). CLAUDE.md: no dark
// theme by default. Like every browser module, it never names the platform.

/** One preference: a key in localStorage, the attribute it sets on <html>, and the choices. */
export interface Preference {
  /** The localStorage key. Namespaced `pref.`; it never names the platform. */
  key: string;
  /** The attribute put on <html> for a non-default choice (removed for the default). */
  attr: string;
  /** What it does, for the preferences page. */
  label: string;
  /** A short help line, in plain words. */
  help: string;
  /** The choices; the first is the default and sets no attribute. */
  options: { value: string; label: string }[];
  /** A choice that CSS cannot carry out alone and a script must honour (hovercards, autoplay). */
  behavioural?: boolean;
}

export const PREFERENCES: readonly Preference[] = [
  {
    key: "pref.theme",
    attr: "data-theme",
    label: "Theme",
    help: "Light is the default. A dark theme is here if you want it; it is never forced on you.",
    options: [
      { value: "light", label: "Light (default)" },
      { value: "dark", label: "Dark" },
    ],
  },
  {
    key: "pref.contrast",
    attr: "data-contrast",
    label: "Contrast",
    help: "More contrast darkens the text, the faint text and the lines, and thickens the focus ring.",
    options: [
      { value: "normal", label: "Normal (default)" },
      { value: "more", label: "More contrast" },
    ],
  },
  {
    key: "pref.vision",
    attr: "data-vision",
    label: "Colour-vision palette",
    help: "Changes the colours of the charts and the coloured marks so each one stays distinct. It does not change anything else.",
    options: [
      { value: "default", label: "Default palette" },
      { value: "deuteranopia", label: "Deuteranopia and protanopia (red and green)" },
      { value: "tritanopia", label: "Tritanopia (blue and yellow)" },
    ],
  },
  {
    key: "pref.underline",
    attr: "data-underline",
    label: "Link underlines",
    help: "Underline every link, not only the one under the pointer.",
    options: [
      { value: "hover", label: "On hover (default)" },
      { value: "always", label: "Always" },
    ],
  },
  {
    key: "pref.motion",
    attr: "data-motion",
    label: "Motion",
    help: "Stop the few transitions. Your system's reduced-motion setting is honoured on its own; this forces it.",
    options: [
      { value: "system", label: "Follow the system (default)" },
      { value: "reduced", label: "Reduce motion" },
    ],
  },
  {
    key: "pref.line",
    attr: "data-line",
    label: "Line spacing",
    help: "How far apart the lines of text sit.",
    options: [
      { value: "normal", label: "Normal (default)" },
      { value: "roomy", label: "Roomy" },
      { value: "tight", label: "Tight" },
    ],
  },
  {
    key: "pref.tab",
    attr: "data-tab",
    label: "Tab size",
    help: "How many spaces a tab takes in the code views.",
    options: [
      { value: "4", label: "4 (default)" },
      { value: "2", label: "2" },
      { value: "8", label: "8" },
    ],
  },
  {
    key: "pref.md",
    attr: "data-md",
    label: "Markdown font",
    help: "Show rendered Markdown in a fixed-width font, so prose and code line up.",
    options: [
      { value: "normal", label: "Normal (default)" },
      { value: "fixed", label: "Fixed-width" },
    ],
  },
  {
    key: "pref.hovercards",
    attr: "data-hovercards",
    label: "Hovercards",
    help: "The small card that opens when the pointer rests on a link. Turn it off here.",
    behavioural: true,
    options: [
      { value: "on", label: "On (default)" },
      { value: "off", label: "Off" },
    ],
  },
  {
    key: "pref.autoplay",
    attr: "data-autoplay",
    label: "Animated images",
    help: "Play animated images (GIFs) on their own, or only when you ask.",
    behavioural: true,
    options: [
      { value: "on", label: "Play on their own (default)" },
      { value: "off", label: "Play on click" },
    ],
  },
  {
    key: "pref.shortcuts",
    attr: "data-shortcuts",
    label: "Character shortcuts",
    help: "The single-key shortcuts (for example g then i). The command palette and ? still work either way.",
    behavioural: true,
    options: [
      { value: "on", label: "On (default)" },
      { value: "off", label: "Off" },
    ],
  },
  {
    key: "pref.skintone",
    attr: "data-skintone",
    label: "Emoji skin tone",
    help: "The default skin tone when you add an emoji.",
    behavioural: true,
    options: [
      { value: "default", label: "Default" },
      { value: "light", label: "Light" },
      { value: "medium-light", label: "Medium light" },
      { value: "medium", label: "Medium" },
      { value: "medium-dark", label: "Medium dark" },
      { value: "dark", label: "Dark" },
    ],
  },
] as const;

const BY_KEY = new Map(PREFERENCES.map((p) => [p.key, p]));

/** The default value of a preference (its first option). */
export function defaultOf(p: Preference): string {
  return p.options[0].value;
}

/** A stored value kept only when it is one of the choices, else the default. Pure: the raw string
 *  (or null) comes from the caller, so storage guards stay in prefs.ts. */
export function valueOf(p: Preference, stored: string | null | undefined): string {
  return stored != null && p.options.some((o) => o.value === stored) ? stored : defaultOf(p);
}

/** Every preference's current value, read through `get` (a pure accessor over localStorage). */
export function currentValues(get: (key: string) => string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of PREFERENCES) out[p.key] = valueOf(p, get(p.key));
  return out;
}

/** The attributes to set on <html>, and the ones to remove (the defaults). A default sets no
 *  attribute, so a page with no stored preference carries none: light, normal, nothing forced. */
export function appliedAttributes(get: (key: string) => string | null | undefined): { set: Record<string, string>; remove: string[] } {
  const set: Record<string, string> = {};
  const remove: string[] = [];
  for (const p of PREFERENCES) {
    const v = valueOf(p, get(p.key));
    if (v === defaultOf(p)) remove.push(p.attr);
    else set[p.attr] = v;
  }
  return { set, remove };
}

/** A key is a known preference. */
export function isPreferenceKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** The preference for a key, or undefined. */
export function preferenceOf(key: string): Preference | undefined {
  return BY_KEY.get(key);
}
